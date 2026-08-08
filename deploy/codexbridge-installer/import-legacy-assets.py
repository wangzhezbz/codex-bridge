#!/usr/bin/env python3
"""Safely normalize the legacy ChatGPT bundle and split the legacy Skills bundle.

The source archives stay read-only. Published objects are immutable and a metadata
file is produced for the Node catalog signer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 16_384
MAX_TOTAL_BYTES = 16 * 1_024 * 1_024 * 1_024
SKILL_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
VERSION = re.compile(r"^\d+(?:\.\d+){0,3}$")
RESERVED = re.compile(r"^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)
INVALID_WINDOWS = re.compile(r'[<>:"|?*\x00-\x1f]')


def fail(code: str) -> RuntimeError:
    return RuntimeError(code)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_source(path: str, expected_sha256: str) -> Path:
    source = Path(path)
    if not source.is_absolute() or not source.is_file():
        raise fail("legacy_source_invalid")
    actual = sha256_file(source)
    if actual != expected_sha256.lower():
        raise fail("legacy_source_hash_mismatch")
    return source


def safe_relative(raw: str) -> str:
    if not raw or "\\" in raw or raw.startswith("/") or "\x00" in raw:
        raise fail("legacy_archive_path_invalid")
    parts = raw.split("/")
    if any(not part or part in (".", "..") or INVALID_WINDOWS.search(part)
           or part.endswith((" ", ".")) or RESERVED.match(part) for part in parts):
        raise fail("legacy_archive_path_invalid")
    normalized = str(PurePosixPath(*parts))
    if normalized != raw:
        raise fail("legacy_archive_path_invalid")
    return normalized


def validate_info(info: zipfile.ZipInfo) -> None:
    if info.flag_bits & 1:
        raise fail("legacy_archive_encrypted")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise fail("legacy_archive_compression_invalid")
    unix_type = (info.external_attr >> 16) & 0o170000
    if unix_type == stat.S_IFLNK or info.external_attr & 0x400:
        raise fail("legacy_archive_link_rejected")
    if info.file_size < 0 or info.file_size > MAX_TOTAL_BYTES:
        raise fail("legacy_archive_size_invalid")


def normalized_info(name: str) -> zipfile.ZipInfo:
    result = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    result.compress_type = zipfile.ZIP_DEFLATED
    result.create_system = 3
    result.external_attr = (0o100644 << 16)
    result.flag_bits = 0x800
    result.comment = b""
    result.extra = b""
    return result


def immutable_zip(destination: Path, source: zipfile.ZipFile, entries: list[tuple[str, zipfile.ZipInfo]],
                  generated: dict[str, bytes] | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.{os.getpid()}.part"
    if temporary.exists():
        raise fail("legacy_temporary_exists")
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9,
                             allowZip64=True) as output:
            for relative, info in entries:
                with source.open(info, "r") as incoming, output.open(
                    normalized_info(relative), "w", force_zip64=True
                ) as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            for relative, data in sorted((generated or {}).items()):
                safe_relative(relative)
                if any(relative.casefold() == name.casefold() for name, _ in entries):
                    raise fail("legacy_archive_duplicate_path")
                output.writestr(normalized_info(relative), data)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            if sha256_file(temporary) != sha256_file(destination):
                raise fail("legacy_immutable_object_exists")
        os.unlink(temporary)
    except BaseException:
        if temporary.exists():
            os.unlink(temporary)
        raise


def collect_chatgpt(source: zipfile.ZipFile, version: str) -> list[tuple[str, zipfile.ZipInfo]]:
    prefix = f"OpenAI.Codex_{version}_x64/app/"
    result: list[tuple[str, zipfile.ZipInfo]] = []
    folded: set[str] = set()
    total = 0
    for info in source.infolist():
        validate_info(info)
        if info.is_dir() or not info.filename.startswith(prefix):
            continue
        relative = safe_relative(info.filename[len(prefix):])
        key = relative.casefold()
        if key in folded:
            raise fail("legacy_archive_duplicate_path")
        folded.add(key)
        total += info.file_size
        result.append((relative, info))
    result.sort(key=lambda item: item[0].casefold())
    if not result or len(result) > MAX_ENTRIES or total > MAX_TOTAL_BYTES:
        raise fail("legacy_chatgpt_tree_invalid")
    if not any(name == "ChatGPT.exe" for name, _ in result):
        raise fail("legacy_chatgpt_entrypoint_missing")
    return result


def collect_skills(source: zipfile.ZipFile) -> dict[str, list[tuple[str, zipfile.ZipInfo]]]:
    result: dict[str, list[tuple[str, zipfile.ZipInfo]]] = {}
    folded: dict[str, set[str]] = {}
    totals: dict[str, int] = {}
    for info in source.infolist():
        validate_info(info)
        if info.is_dir():
            continue
        raw_parts = info.filename.split("/", 1)
        if len(raw_parts) != 2 or not SKILL_ID.fullmatch(raw_parts[0]):
            raise fail("legacy_skill_id_invalid")
        skill_id, raw_relative = raw_parts
        relative = safe_relative(raw_relative)
        key = relative.casefold()
        folded.setdefault(skill_id, set())
        if key in folded[skill_id]:
            raise fail("legacy_archive_duplicate_path")
        folded[skill_id].add(key)
        totals[skill_id] = totals.get(skill_id, 0) + info.file_size
        result.setdefault(skill_id, []).append((relative, info))
    for skill_id, entries in result.items():
        entries.sort(key=lambda item: item[0].casefold())
        if len(entries) > MAX_ENTRIES or totals[skill_id] > MAX_TOTAL_BYTES:
            raise fail("legacy_skill_tree_invalid")
        if not any(name == "SKILL.md" for name, _ in entries):
            raise fail("legacy_skill_entrypoint_missing")
    if not result:
        raise fail("legacy_skills_empty")
    return dict(sorted(result.items()))


def display_name(skill_id: str) -> str:
    return " ".join(part[:1].upper() + part[1:] for part in skill_id.split("-"))


def skill_description(source: zipfile.ZipFile, entries: list[tuple[str, zipfile.ZipInfo]], skill_id: str) -> str:
    info = next(info for name, info in entries if name == "SKILL.md")
    with source.open(info) as handle:
        text = handle.read(min(info.file_size, 256 * 1024)).decode("utf-8", errors="replace")
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for index, line in enumerate(lines[1:], start=1):
            if line.strip() == "---":
                break
            match = re.match(r"^description:\s*(.*)$", line)
            if not match:
                continue
            value = match.group(1).strip()
            if value in ("|", ">", "|-", ">-"):
                folded = []
                for continuation in lines[index + 1:]:
                    if continuation and not continuation[0].isspace():
                        break
                    if continuation.strip():
                        folded.append(continuation.strip())
                value = " ".join(folded)
            elif len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if value:
                return value
    return f"{display_name(skill_id)} skill."


def asset_record(path: Path) -> tuple[int, str]:
    return path.stat().st_size, sha256_file(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chatgpt-zip", required=True)
    parser.add_argument("--chatgpt-version", required=True)
    parser.add_argument("--chatgpt-sha256", required=True)
    parser.add_argument("--skills-zip", required=True)
    parser.add_argument("--skills-version", required=True)
    parser.add_argument("--skills-sha256", required=True)
    parser.add_argument("--public-root", required=True)
    parser.add_argument("--package-base-url", required=True)
    parser.add_argument("--metadata", required=True)
    args = parser.parse_args()
    if not VERSION.fullmatch(args.chatgpt_version) or not VERSION.fullmatch(args.skills_version):
        raise fail("legacy_version_invalid")
    public_root = Path(args.public_root)
    metadata_path = Path(args.metadata)
    if not public_root.is_absolute() or not metadata_path.is_absolute():
        raise fail("legacy_destination_invalid")
    chatgpt_source = require_source(args.chatgpt_zip, args.chatgpt_sha256)
    skills_source = require_source(args.skills_zip, args.skills_sha256)
    published_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    with zipfile.ZipFile(chatgpt_source, "r") as source:
        entries = collect_chatgpt(source, args.chatgpt_version)
        marker_name = ".codexbridge-chatgpt-version.json"
        marker = (json.dumps({
            "schemaVersion": 1, "componentId": "chatgpt", "version": args.chatgpt_version,
        }, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        package_name = f"chatgpt-{args.chatgpt_version}-x64.zip"
        package_path = public_root / "packages" / package_name
        immutable_zip(package_path, source, entries, {marker_name: marker})
        size, sha256 = asset_record(package_path)
        required_files = sorted([name for name, _ in entries] + [marker_name], key=str.casefold)
        component = {
            "id": "chatgpt", "name": "ChatGPT", "version": args.chatgpt_version,
            "architecture": "x64", "format": "zip",
            "assetUrl": f"{args.package_base_url.rstrip('/')}/{package_name}",
            "size": size, "sha256": sha256, "entrypoint": "ChatGPT.exe",
            "requiredFiles": required_files,
            "maxRelativePathLength": max(map(len, required_files)),
            "publishedAt": published_at, "supportsRollback": True,
        }

    skills = []
    with zipfile.ZipFile(skills_source, "r") as source:
        grouped = collect_skills(source)
        for skill_id, entries in grouped.items():
            package_name = f"{skill_id}-{args.skills_version}.zip"
            package_path = public_root / "packages" / "skills" / package_name
            immutable_zip(package_path, source, entries)
            size, sha256 = asset_record(package_path)
            skills.append({
                "id": skill_id, "name": display_name(skill_id),
                "description": skill_description(source, entries, skill_id),
                "version": args.skills_version,
                "assetUrl": f"{args.package_base_url.rstrip('/')}/skills/{package_name}",
                "size": size, "sha256": sha256,
                "files": [name for name, _ in entries],
            })

    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_metadata = metadata_path.with_name(f".{metadata_path.name}.{os.getpid()}.part")
    with temporary_metadata.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump({"component": component, "skills": skills}, handle, ensure_ascii=False,
                  sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_metadata, metadata_path)
    print(json.dumps({
        "chatgpt": {"version": component["version"], "size": component["size"], "sha256": component["sha256"],
                    "files": len(component["requiredFiles"])},
        "skills": [{"id": item["id"], "size": item["size"], "sha256": item["sha256"],
                    "files": len(item["files"])} for item in skills],
        "metadata": str(metadata_path),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
