import hashlib
import importlib.util
import json
import os
import tempfile
import unittest


MODULE_PATH = os.path.join(os.path.dirname(__file__), "dogecloud_uploader.py")
SPEC = importlib.util.spec_from_file_location("dogecloud_uploader", MODULE_PATH)
UPLOADER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPLOADER)


class DogeCloudUploaderTests(unittest.TestCase):
    def test_s3_config_falls_back_for_older_botocore_without_checksum_options(self):
        calls = []

        class OlderConfig:
            def __init__(self, **values):
                calls.append(values)
                if "request_checksum_calculation" in values:
                    raise TypeError("unexpected keyword")
                self.values = values

        config = UPLOADER.build_s3_config(OlderConfig)
        self.assertEqual(len(calls), 2)
        self.assertEqual(config.values["signature_version"], "s3v4")
        self.assertEqual(config.values["s3"], {"addressing_style": "virtual"})

    def test_package_binding_requires_exact_size_and_sha256(self):
        with tempfile.TemporaryDirectory() as root:
            package = os.path.join(root, "package.bin")
            with open(package, "wb") as handle:
                handle.write(b"verified-package")
            digest = hashlib.sha256(b"verified-package").hexdigest()
            self.assertEqual(
                UPLOADER.verify_package(package, len(b"verified-package"), digest),
                os.path.abspath(package),
            )
            with self.assertRaisesRegex(ValueError, "dogecloud_source_binding_invalid"):
                UPLOADER.verify_package(package, 1, digest)

    def test_object_scope_stays_inside_isolated_test_prefix(self):
        self.assertEqual(
            UPLOADER.require_object_key("codexbridge-test/packages/skills/documents.zip"),
            "codexbridge-test/packages/skills/documents.zip",
        )
        for rejected in (
            "packages/chatgpt.zip",
            "codexbridge-test/packages/../escape.zip",
            "/codexbridge-test/packages/chatgpt.zip",
            "codexbridge-test/packages/a\\b.zip",
        ):
            with self.assertRaisesRegex(ValueError, "dogecloud_object_key_rejected"):
                UPLOADER.require_object_key(rejected)

    def test_upload_token_scope_adds_only_get_permission_for_post_upload_verification(self):
        self.assertEqual(UPLOADER.build_upload_token_body(
            "codex",
            "codexbridge-test/packages/chatgpt.zip",
        ), {
            "channel": "OSS_UPLOAD",
            "scopes": ["codex:codexbridge-test/packages/chatgpt.zip"],
            "allowActions": ["GetObject"],
        })

    def test_tmp_token_response_requires_one_matching_bucket_and_complete_credentials(self):
        response = {
            "code": 200,
            "data": {
                "Credentials": {
                    "accessKeyId": "temporary-access",
                    "secretAccessKey": "temporary-secret",
                    "sessionToken": "temporary-session",
                },
                "Buckets": [{
                    "name": "codex",
                    "s3Bucket": "s-cd-example-codex",
                    "s3Endpoint": "https://example.s3.dogecloud.com",
                }],
            },
        }
        parsed = UPLOADER.parse_tmp_token_response(response, "codex")
        self.assertEqual(parsed["s3_bucket"], "s-cd-example-codex")
        self.assertEqual(parsed["s3_endpoint"], "https://example.s3.dogecloud.com")
        broken = json.loads(json.dumps(response))
        broken["data"]["Credentials"].pop("sessionToken")
        with self.assertRaisesRegex(ValueError, "dogecloud_tmp_token_invalid"):
            UPLOADER.parse_tmp_token_response(broken, "codex")

    def test_remote_verification_uses_one_byte_get_when_head_is_not_authorized(self):
        calls = []

        class Body:
            def read(self):
                return b"x"

            def close(self):
                calls.append("closed")

        class Client:
            def get_object(self, **values):
                calls.append(values)
                return {
                    "Body": Body(),
                    "ContentRange": "bytes 0-0/42",
                    "Metadata": {"sha256": "a" * 64},
                }

        UPLOADER.verify_remote_object(Client(), "bucket", "object", 42, "a" * 64)
        self.assertEqual(calls[0], {"Bucket": "bucket", "Key": "object", "Range": "bytes=0-0"})
        self.assertEqual(calls[1], "closed")


if __name__ == "__main__":
    unittest.main()
