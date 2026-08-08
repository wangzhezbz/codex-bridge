#!/usr/bin/env python3
"""Upload one immutable public object to Tencent COS with resumable multipart PUTs."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


def atomic_write_json(path: Path, value: dict) -> None:
    temp = path.with_name(f"{path.name}.next")
    data = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)
    os.replace(temp, path)


def query_url(url: str, **values: str | int) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.urlencode(values)
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, query, "")
    )


def request_bytes(
    request: urllib.request.Request,
    *,
    timeout: int,
    attempts: int = 6,
) -> tuple[bytes, dict[str, str]]:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(
                request, timeout=timeout, context=ssl.create_default_context()
            ) as response:
                body = response.read()
                return body, dict(response.headers.items())
        except (OSError, urllib.error.URLError) as error:
            last_error = error
            if attempt == attempts:
                break
            time.sleep(min(30, 2 ** (attempt - 1)))
    raise RuntimeError(f"request failed after {attempts} attempts: {last_error}")


def find_xml_text(body: bytes, name: str) -> str:
    root = ET.fromstring(body)
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] == name and element.text:
            return element.text
    raise RuntimeError(f"multipart response omitted {name}")


def read_part(path: Path, offset: int, size: int) -> bytes:
    fd = os.open(path, os.O_RDONLY)
    try:
        data = os.pread(fd, size, offset)
    finally:
        os.close(fd)
    if len(data) != size:
        raise RuntimeError(
            f"short local read at {offset}: expected {size}, received {len(data)}"
        )
    return data


def upload(args: argparse.Namespace) -> None:
    source = args.file.resolve(strict=True)
    size = source.stat().st_size
    if not source.is_file() or size <= 0:
        raise RuntimeError("source must be one non-empty regular file")

    state_path = args.state.resolve()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()

    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        expected = {
            "url": args.url,
            "file": str(source),
            "size": size,
            "partSize": args.part_size,
        }
        for key, value in expected.items():
            if state.get(key) != value:
                raise RuntimeError(f"state does not match current {key}")
        upload_id = state["uploadId"]
        completed = dict(state.get("completed", {}))
        print(f"resuming upload {upload_id} with {len(completed)} completed parts", flush=True)
    else:
        initiate = urllib.request.Request(
            f"{args.url}?uploads",
            data=b"",
            method="POST",
        )
        body, _ = request_bytes(initiate, timeout=args.timeout)
        upload_id = find_xml_text(body, "UploadId")
        completed = {}
        state = {
            "url": args.url,
            "file": str(source),
            "size": size,
            "partSize": args.part_size,
            "uploadId": upload_id,
            "completed": completed,
        }
        atomic_write_json(state_path, state)
        print(f"started upload {upload_id}", flush=True)

    part_count = (size + args.part_size - 1) // args.part_size

    def upload_part(part_number: int) -> tuple[int, str]:
        key = str(part_number)
        with lock:
            prior = completed.get(key)
        if prior:
            return part_number, prior
        offset = (part_number - 1) * args.part_size
        part_length = min(args.part_size, size - offset)
        data = read_part(source, offset, part_length)
        content_md5 = base64.b64encode(hashlib.md5(data).digest()).decode("ascii")
        request = urllib.request.Request(
            query_url(
                args.url,
                partNumber=part_number,
                uploadId=upload_id,
            ),
            data=data,
            headers={
                "Content-Length": str(len(data)),
                "Content-MD5": content_md5,
            },
            method="PUT",
        )
        _, headers = request_bytes(request, timeout=args.timeout)
        etag = headers.get("ETag") or headers.get("Etag")
        if not etag:
            raise RuntimeError(f"part {part_number} response omitted ETag")
        with lock:
            completed[key] = etag
            state["completed"] = dict(completed)
            atomic_write_json(state_path, state)
            done = len(completed)
        print(f"part {part_number}/{part_count} complete ({done} total)", flush=True)
        return part_number, etag

    pending = [
        number
        for number in range(1, part_count + 1)
        if str(number) not in completed
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(upload_part, number) for number in pending]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    if len(completed) != part_count:
        raise RuntimeError("not every multipart chunk has an ETag")

    parts_xml = "".join(
        "<Part>"
        f"<PartNumber>{number}</PartNumber>"
        f"<ETag>{completed[str(number)]}</ETag>"
        "</Part>"
        for number in range(1, part_count + 1)
    )
    complete_body = (
        f"<CompleteMultipartUpload>{parts_xml}</CompleteMultipartUpload>"
    ).encode("utf-8")
    complete_md5 = base64.b64encode(hashlib.md5(complete_body).digest()).decode(
        "ascii"
    )
    complete_request = urllib.request.Request(
        query_url(args.url, uploadId=upload_id),
        data=complete_body,
        headers={
            "Content-Type": "application/xml",
            "Content-Length": str(len(complete_body)),
            "Content-MD5": complete_md5,
        },
        method="POST",
    )
    complete_response, _ = request_bytes(complete_request, timeout=args.timeout)
    if b"<Error>" in complete_response:
        raise RuntimeError(complete_response.decode("utf-8", errors="replace"))

    head = urllib.request.Request(args.url, method="HEAD")
    _, headers = request_bytes(head, timeout=args.timeout)
    remote_size = int(headers.get("Content-Length", "-1"))
    if remote_size != size:
        raise RuntimeError(
            f"completed object size mismatch: expected {size}, received {remote_size}"
        )
    print(f"MULTIPART_UPLOAD_OK bytes={size} parts={part_count}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--part-size", type=int, default=32 * 1024 * 1024)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 16:
        parser.error("--workers must be between 1 and 16")
    if args.part_size < 5 * 1024 * 1024:
        parser.error("--part-size must be at least 5 MiB")
    return args


if __name__ == "__main__":
    upload(parse_args())
