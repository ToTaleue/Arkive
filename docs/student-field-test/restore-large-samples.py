"""Restore split samples after git lfs pull, without overwriting existing files."""

import argparse
import hashlib
import json
import os
from pathlib import Path


def local_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError(f"Path outside sample directory: {relative}")
    return path


def digest_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def restore(root, entry, verify_only=False):
    target = local_path(root, entry["path"])
    if not verify_only and target.exists():
        if target.stat().st_size != entry["bytes"] or digest_file(target) != entry["sha256"]:
            raise ValueError(f"Existing file differs; refusing to overwrite: {target}")
        print(f"Already present and verified: {entry['path']}", flush=True)
        return

    temporary = target.with_name(target.name + ".restoring")
    output = None
    total = 0
    complete_hash = hashlib.sha256()
    try:
        if not verify_only:
            target.parent.mkdir(parents=True, exist_ok=True)
            output = temporary.open("xb")
        for part in entry["parts"]:
            source = local_path(root, part["path"])
            if source.stat().st_size != part["bytes"]:
                raise ValueError(f"Part size mismatch; run git lfs pull: {source}")
            part_hash = hashlib.sha256()
            with source.open("rb") as stream:
                while block := stream.read(8 * 1024 * 1024):
                    part_hash.update(block)
                    complete_hash.update(block)
                    total += len(block)
                    if output is not None:
                        output.write(block)
            if part_hash.hexdigest() != part["sha256"]:
                raise ValueError(f"Part checksum mismatch: {source}")
        if total != entry["bytes"] or complete_hash.hexdigest() != entry["sha256"]:
            raise ValueError(f"Reassembled sample checksum mismatch: {entry['path']}")
        if output is not None:
            output.flush()
            os.fsync(output.fileno())
            output.close()
            # Hard-link publication is atomic and refuses a concurrently created target.
            os.link(temporary, target)
        print(f"{'Verified parts' if verify_only else 'Restored'}: {entry['path']}", flush=True)
    finally:
        if output is not None:
            output.close()
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Check all parts without restoring")
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "sample-manifest.json").read_text(encoding="utf-8"))
    if manifest["format"] != 1:
        raise ValueError("Unsupported sample manifest format")
    for entry in manifest["files"]:
        if entry["storage"] == "lfs-parts":
            restore(root, entry, arguments.verify_only)


if __name__ == "__main__":
    main()
