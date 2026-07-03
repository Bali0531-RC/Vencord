#!/usr/bin/env python3
"""
Auto-resolves merge conflicts after syncing with upstream Vendicated/Vencord.

Strategy per file:
  src/utils/constants.ts  — keep BOTH HEAD and upstream sections (additive: new devs).
  All other files         — abort with an error (needs manual resolution).
"""

import re
import subprocess
import sys


CONFLICT_RE = re.compile(
    r"<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> [^\n]+",
    re.DOTALL,
)


def conflicted_files() -> list[str]:
    out = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"],
        text=True,
    ).strip()
    return out.splitlines() if out else []


def resolve_keep_both(path: str) -> None:
    """Resolve a conflict by keeping entries from both HEAD and upstream."""
    with open(path) as f:
        src = f.read()

    def merge(m: re.Match) -> str:
        head = m.group(1).rstrip()
        upstream = m.group(2)
        # Ensure the HEAD block ends with a comma so the TS object stays valid.
        if head and not head.endswith(","):
            head += ","
        return head + "\n" + upstream

    resolved = CONFLICT_RE.sub(merge, src)

    if "<<<<<<<" in resolved:
        print(f"ERROR: could not fully resolve all conflicts in {path}", file=sys.stderr)
        sys.exit(1)

    with open(path, "w") as f:
        f.write(resolved)

    subprocess.run(["git", "add", path], check=True)
    print(f"  resolved: {path}")


def main() -> None:
    files = conflicted_files()

    if not files:
        print("No conflicted files — merge was clean.")
        return

    print(f"Conflicted files: {files}")

    for path in files:
        if path == "src/utils/constants.ts":
            print(f"Resolving {path} (keep-both strategy)...")
            resolve_keep_both(path)
        else:
            print(
                f"ERROR: unexpected conflict in '{path}'. "
                "Add a resolver rule to this script or fix manually.",
                file=sys.stderr,
            )
            sys.exit(1)


if __name__ == "__main__":
    main()
