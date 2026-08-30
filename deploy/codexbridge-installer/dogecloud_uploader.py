#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request


API_ORIGIN = "https://api.dogecloud.com"
OBJECT_PREFIX = "codexbridge-test/packages/"
CDN_PREFIX = "https://download.shanhaiyouling.com/codexbridge-test/packages/"
SHA256 = frozenset("0123456789abcdef")


def require_object_key(value):
    if not isinstance(value, str) or not value.startswith(OBJECT_PREFIX):
        raise ValueError("dogecloud_object_key_rejected")
    parts = value.split("/")
    if (not value or value.startswith("/") or "\\" in value
            or any(not part or part in (".", "..") for part in parts)):
        raise ValueError("dogecloud_object_key_rejected")
    return value


def verify_package(file_path, expected_size, expected_sha256):
    exact = os.path.abspath(file_path)
    if exact != file_path or not os.path.isfile(exact):
        raise ValueError("dogecloud_source_file_invalid")
    if (not isinstance(expected_size, int) or expected_size < 1
            or not isinstance(expected_sha256, str) or len(expected_sha256) != 64
            or any(char not in SHA256 for char in expected_sha256)):
        raise ValueError("dogecloud_source_binding_invalid")
    digest = hashlib.sha256()
    size = 0
    with open(exact, "rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            digest.update(block)
    if size != expected_size or digest.hexdigest() != expected_sha256:
        raise ValueError("dogecloud_source_binding_invalid")
    return exact


def dogecloud_api(path, body, access_key, secret_key):
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sign = hmac.new(secret_key.encode("utf-8"), path.encode("utf-8") + b"\n" + encoded, hashlib.sha1).hexdigest()
    request = urllib.request.Request(
        API_ORIGIN + path,
        data=encoded,
        headers={
            "Authorization": "TOKEN " + access_key + ":" + sign,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_tmp_token_response(response, bucket_name):
    try:
        if response.get("code") != 200:
            raise ValueError("dogecloud_tmp_token_rejected")
        data = response["data"]
        credentials = data["Credentials"]
        buckets = data["Buckets"]
        if len(buckets) != 1:
            raise ValueError("dogecloud_tmp_token_invalid")
        bucket = buckets[0]
        if bucket.get("name") not in (None, bucket_name):
            raise ValueError("dogecloud_tmp_token_invalid")
        required = ("accessKeyId", "secretAccessKey", "sessionToken")
        if not all(isinstance(credentials.get(key), str) and credentials[key] for key in required):
            raise ValueError("dogecloud_tmp_token_invalid")
        s3_bucket = bucket["s3Bucket"]
        s3_endpoint = bucket["s3Endpoint"]
        if not isinstance(s3_bucket, str) or not s3_bucket:
            raise ValueError("dogecloud_tmp_token_invalid")
        if not isinstance(s3_endpoint, str) or not s3_endpoint.startswith("https://"):
            raise ValueError("dogecloud_tmp_token_invalid")
    except (KeyError, TypeError):
        raise ValueError("dogecloud_tmp_token_invalid")
    return {
        "credentials": credentials,
        "s3_bucket": s3_bucket,
        "s3_endpoint": s3_endpoint,
    }


def build_upload_token_body(bucket_name, object_key):
    return {
        "channel": "OSS_UPLOAD",
        "scopes": [bucket_name + ":" + object_key],
        "allowActions": ["GetObject"],
    }


def request_upload_token(bucket_name, object_key, access_key, secret_key):
    response = dogecloud_api(
        "/auth/tmp_token.json",
        build_upload_token_body(bucket_name, object_key),
        access_key,
        secret_key,
    )
    return parse_tmp_token_response(response, bucket_name)


def public_head(url, expected_size):
    request = urllib.request.Request(url, method="HEAD", headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=60) as response:
        length = response.headers.get("Content-Length")
        if response.status != 200 or length is None or int(length) != expected_size:
            raise ValueError("dogecloud_public_head_invalid")


def build_s3_config(config_class):
    common = {
        "signature_version": "s3v4",
        "s3": {"addressing_style": "virtual"},
        "retries": {"max_attempts": 5, "mode": "standard"},
    }
    try:
        return config_class(
            **common,
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
    except TypeError:
        return config_class(**common)


def verify_remote_object(client, bucket, object_key, expected_size, expected_sha256):
    response = client.get_object(Bucket=bucket, Key=object_key, Range="bytes=0-0")
    body = response.get("Body")
    try:
        if body is None or len(body.read()) != 1:
            raise ValueError("dogecloud_uploaded_object_invalid")
    finally:
        if body is not None:
            body.close()
    content_range = response.get("ContentRange", "")
    try:
        total_size = int(content_range.rsplit("/", 1)[1])
    except (IndexError, TypeError, ValueError):
        raise ValueError("dogecloud_uploaded_object_invalid")
    metadata = response.get("Metadata") or {}
    if total_size != expected_size or metadata.get("sha256") != expected_sha256:
        raise ValueError("dogecloud_uploaded_object_invalid")


def upload(args):
    access_key = os.environ.get("CBI_DOGECLOUD_ACCESS_KEY", "").strip()
    secret_key = os.environ.get("CBI_DOGECLOUD_SECRET_KEY", "").strip()
    if not access_key or not secret_key:
        raise ValueError("dogecloud_credentials_required")
    object_key = require_object_key(args.object_key)
    expected_size = int(args.expected_size)
    source = verify_package(args.file, expected_size, args.expected_sha256)
    expected_url = CDN_PREFIX + object_key[len(OBJECT_PREFIX):]
    if args.cdn_url != expected_url:
        raise ValueError("dogecloud_cdn_url_rejected")
    token = request_upload_token(args.bucket, object_key, access_key, secret_key)

    import boto3
    from boto3.s3.transfer import TransferConfig
    from botocore.client import Config

    credentials = token["credentials"]
    client = boto3.client(
        "s3",
        aws_access_key_id=credentials["accessKeyId"],
        aws_secret_access_key=credentials["secretAccessKey"],
        aws_session_token=credentials["sessionToken"],
        endpoint_url=token["s3_endpoint"],
        region_name="automatic",
        config=build_s3_config(Config),
    )
    content_type = mimetypes.guess_type(source)[0] or "application/octet-stream"
    client.upload_file(
        source,
        token["s3_bucket"],
        object_key,
        ExtraArgs={
            "ContentType": content_type,
            "CacheControl": "public, max-age=31536000, immutable",
            "Metadata": {"sha256": args.expected_sha256},
        },
        Config=TransferConfig(
            multipart_threshold=16 * 1024 * 1024,
            multipart_chunksize=16 * 1024 * 1024,
            max_concurrency=4,
            use_threads=True,
        ),
    )
    verify_remote_object(client, token["s3_bucket"], object_key, expected_size, args.expected_sha256)
    public_head(args.cdn_url, expected_size)
    return {
        "action": "uploaded",
        "objectKey": object_key,
        "size": expected_size,
        "sha256": args.expected_sha256,
    }


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--object-key", required=True)
    parser.add_argument("--cdn-url", required=True)
    parser.add_argument("--expected-size", required=True)
    parser.add_argument("--expected-sha256", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        result = upload(parse_args(argv))
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:
        sys.stderr.write(str(error) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
