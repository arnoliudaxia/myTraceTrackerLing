#!/usr/bin/env python3
"""Filter CSV rows by per-day data point count while preserving row text.

Rows whose day has at most N data points are removed. The script parses CSV
only to identify the day column; output rows are copied from the original file
text so field formatting, quoting, precision, and column order are unchanged.
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path


def split_records_preserving_newlines(text: str) -> list[str]:
    """Split CSV text into physical records, preserving each record newline."""
    records = text.splitlines(keepends=True)
    if text and not text.endswith(("\n", "\r")):
        return records
    return records


def parse_single_csv_record(record: str) -> list[str]:
    """Parse one CSV record after trimming its trailing newline only."""
    record_without_newline = record.rstrip("\r\n")
    parsed = list(csv.reader(io.StringIO(record_without_newline)))
    if len(parsed) != 1:
        raise ValueError(f"Expected one CSV record, got {len(parsed)}")
    return parsed[0]


def read_text(path: Path, encoding: str) -> str:
    if encoding.lower() == "utf-8-sig":
        return path.read_text(encoding="utf-8-sig")
    return path.read_text(encoding=encoding)


def write_text_atomic(path: Path, text: str, encoding: str) -> None:
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
        text=True,
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as handle:
            handle.write(text)
        shutil.move(str(tmp_path), str(path))
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        finally:
            raise


def filter_csv_days(
    input_path: Path,
    output_path: Path,
    day_column: str,
    max_points: int,
    encoding: str,
) -> dict[str, int]:
    text = read_text(input_path, encoding)
    records = split_records_preserving_newlines(text)
    if not records:
        raise ValueError("Input CSV is empty")

    header_record = records[0]
    header = parse_single_csv_record(header_record)
    try:
        day_index = header.index(day_column)
    except ValueError as exc:
        raise ValueError(f"Column not found: {day_column}") from exc

    data_records: list[tuple[str, str]] = []
    counts: Counter[str] = Counter()
    for line_number, record in enumerate(records[1:], start=2):
        if not record.rstrip("\r\n"):
            continue
        fields = parse_single_csv_record(record)
        if day_index >= len(fields):
            raise ValueError(
                f"Line {line_number} has {len(fields)} fields, "
                f"but day column index is {day_index}"
            )
        day_value = fields[day_index]
        data_records.append((record, day_value))
        counts[day_value] += 1

    keep_days = {day for day, count in counts.items() if count > max_points}
    kept_records = [record for record, day in data_records if day in keep_days]
    output_text = header_record + "".join(kept_records)

    if input_path.resolve() == output_path.resolve():
        write_text_atomic(output_path, output_text, encoding)
    else:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output_text, encoding=encoding, newline="")

    removed_records = len(data_records) - len(kept_records)
    removed_days = sum(1 for count in counts.values() if count <= max_points)
    return {
        "original_records": len(data_records),
        "kept_records": len(kept_records),
        "removed_records": removed_records,
        "original_days": len(counts),
        "kept_days": len(keep_days),
        "removed_days": removed_days,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Remove all CSV rows for days whose data point count is less than "
            "or equal to a threshold, preserving original row formatting."
        )
    )
    parser.add_argument("input", type=Path, help="Input CSV path")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output CSV path. Defaults to '<input stem>_filtered.csv'.",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite the input file atomically.",
    )
    parser.add_argument(
        "--day-column",
        default="dayTime",
        help="Column used as the day grouping key. Default: dayTime",
    )
    parser.add_argument(
        "--max-points",
        type=int,
        default=10,
        help="Remove days with this many points or fewer. Default: 10",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8-sig",
        help="CSV text encoding. Default: utf-8-sig",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.in_place and args.output:
        parser.error("--in-place cannot be used with --output")

    input_path = args.input
    if args.in_place:
        output_path = input_path
    elif args.output:
        output_path = args.output
    else:
        output_path = input_path.with_name(f"{input_path.stem}_filtered{input_path.suffix}")

    try:
        stats = filter_csv_days(
            input_path=input_path,
            output_path=output_path,
            day_column=args.day_column,
            max_points=args.max_points,
            encoding=args.encoding,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Output: {output_path}")
    print(f"Original records: {stats['original_records']}")
    print(f"Kept records: {stats['kept_records']}")
    print(f"Removed records: {stats['removed_records']}")
    print(f"Original days: {stats['original_days']}")
    print(f"Kept days: {stats['kept_days']}")
    print(f"Removed days: {stats['removed_days']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
