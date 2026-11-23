"""Turns one or more .trx files (dotnet test --logger trx) into a Markdown test report.

Usage: python tools/test_report.py <results.trx> [more.trx ...] <output.md>
"""
import collections
import datetime
import platform
import sys
import xml.etree.ElementTree as ET

NS = {"t": "http://microsoft.com/schemas/VisualStudio/TeamTest/2010"}
*inputs, output = sys.argv[1:]
rows, counters = [], collections.Counter()
for path in inputs:
    root = ET.parse(path).getroot()
    for r in root.iterfind(".//t:UnitTestResult", NS):
        name = r.get("testName")
        outcome = r.get("outcome")
        duration = r.get("duration", "00:00:00")
        h, m, s = duration.split(":")
        secs = int(h) * 3600 + int(m) * 60 + float(s)
        parts = name.split(".")
        cls = parts[-2] if len(parts) >= 2 else ""
        if "(" in name:  # theory rows: keep the class from before the parenthesis
            cls = name.split("(")[0].split(".")[-2]
        area = parts[2] if len(parts) > 3 else ""
        msg = r.findtext(".//t:Message", default="", namespaces=NS).strip().replace("\n", " ")[:200]
        rows.append((area, cls, name.split(".", 4)[-1] if name.count(".") >= 4 else name, outcome, secs, msg))
        counters[outcome] += 1

by_class = collections.OrderedDict()
for area, cls, test, outcome, secs, msg in sorted(rows):
    by_class.setdefault((area, cls), []).append((test, outcome, secs, msg))

lines = [
    "# Test report", "",
    f"Generated {datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M UTC} on {platform.system()} {platform.release()} ({platform.machine()}).", "",
    f"**Total: {sum(counters.values())} · Passed: {counters['Passed']} · Failed: {counters['Failed']} · Skipped: {counters['NotExecuted']}**", "",
    "| Area | Test class | Tests | Passed | Failed | Skipped | Time (s) |", "|---|---|---:|---:|---:|---:|---:|",
]
for (area, cls), tests in by_class.items():
    c = collections.Counter(t[1] for t in tests)
    lines.append(f"| {area} | {cls} | {len(tests)} | {c['Passed']} | {c['Failed']} | {c['NotExecuted']} | {sum(t[2] for t in tests):.1f} |")
failures = [r for r in rows if r[3] == "Failed"]
if failures:
    lines += ["", "## Failures", ""]
    lines += [f"- `{r[2]}` — {r[5]}" for r in failures]
import os
notes = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_report_notes.md")
if os.path.exists(notes):
    lines += ["", open(notes, encoding="utf-8").read().rstrip()]
lines += ["", "## All tests", "", "| Test | Outcome | Time (s) |", "|---|---|---:|"]
for (area, cls), tests in by_class.items():
    for test, outcome, secs, _ in tests:
        lines.append(f"| `{test}` | {outcome} | {secs:.2f} |")
open(output, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"wrote {output}: {dict(counters)}")
