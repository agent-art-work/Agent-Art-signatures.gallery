#!/usr/bin/env python3
"""Emit one exact, offline design-study capture; never write a production lock."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
LITERALS = (
    "AnyOneCanSignAnyone", "Anyone Can Sign Anyone", "Anyone can sign anyone",
    "Anyone", "Can", "Sign", "can", "sign", "anyone",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("literal", choices=LITERALS)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location(
        "signing_study_capture", Path(__file__).with_name("capture-slogan-v2.py"))
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    capture.DISPLAY_TEXT = args.literal
    print(json.dumps(capture.capture(), separators=(",", ":")))


if __name__ == "__main__":
    main()
