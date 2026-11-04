"""Summarize frozen PM-v1 outputs; semantic judgments remain separate review data."""

import argparse
import json
import statistics
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path)
    parser.add_argument("--reviews", nargs="*", type=Path, default=[])
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit("Refusing to overwrite assessment")
    report = json.loads((args.run / "report.json").read_text())
    manifest = json.loads((args.run / "manifest.json").read_text())
    oracle = json.loads((args.run / "frozen/03-oracle.v1.json").read_text())
    expected = {entry["id"]: entry for entry in oracle["cases"]}
    reviews = {}
    for review in args.reviews:
        for row in json.loads(review.read_text()):
            key = str(row["recordId"])
            if key in reviews:
                raise ValueError(f"Duplicate review: {key}")
            reviews[key] = row

    rows = []
    for result in report["results"]:
        output = result.get("output") or {}
        target = expected[result["caseId"]]
        cites = set(output.get("sourceIds", []))
        source_pass = output.get("kind") == "silent" or (
            set(target["requiredSourceIds"]) <= cites
            and (
                not target["sourceAlternatives"]
                or any(set(alternative) <= cites for alternative in target["sourceAlternatives"])
            )
        )
        kind_pass = output.get("kind") in target["acceptableKinds"]
        grant_pass = not target["requiredGrantId"] or (
            (output.get("preparation") or {}).get("grantId") == target["requiredGrantId"]
        )
        review = reviews.get(str(result["index"]))
        rows.append({
            **result,
            "oracleKindPass": kind_pass,
            "oracleSourcesPass": source_pass,
            "oracleGrantPass": grant_pass,
            "missedRequiredInitiative": "silent" not in target["acceptableKinds"] and output.get("kind") == "silent",
            "review": review,
            "contractAndMeaningPass": bool(
                result["status"] == "completed" and kind_pass and source_pass and grant_pass
                and review and review["meaningPass"] and not review["forbiddenClaim"]
            ),
            "fullyGrounded": bool(
                result["status"] == "completed" and kind_pass and source_pass and grant_pass
                and review and review["meaningPass"] and not review["forbiddenClaim"]
                and not review["otherFactualErrors"]
            ),
        })

    def summary(selected):
        latencies = [row["durationMs"] for row in selected]
        return {
            "calls": len(selected),
            "structurallyValid": sum(row["status"] == "completed" for row in selected),
            "oracleKinds": sum(row["oracleKindPass"] for row in selected),
            "oracleSources": sum(row["oracleSourcesPass"] for row in selected),
            "contractAndMeaning": sum(row["contractAndMeaningPass"] for row in selected),
            "fullyGrounded": sum(row["fullyGrounded"] for row in selected),
            "reviewed": sum(row["review"] is not None for row in selected),
            "missedRequiredInitiatives": sum(row["missedRequiredInitiative"] for row in selected),
            "medianMs": statistics.median(latencies),
            "minMs": min(latencies),
            "maxMs": max(latencies),
            "usageSums": {key: sum(row.get("usage", {}).get(key, 0) for row in selected) for key in (
                "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"
            )},
        }

    arms = {}
    for model in manifest["modelIds"]:
        arms[model] = {
            "initial": summary([row for row in rows if row["model"] == model and not row["repeat"]]),
            "repeats": summary([row for row in rows if row["model"] == model and row["repeat"]]),
        }
    cascade = []
    escalated = []
    for case_id in expected:
        small = next(row for row in rows if row["caseId"] == case_id and row["model"] == "gpt-5.6-luna" and not row["repeat"])
        escalate = small["status"] != "completed" or small["output"]["kind"] != "silent" or small["output"]["uncertainty"] != "none"
        selected = next(row for row in rows if row["caseId"] == case_id and row["model"] == "gpt-6-astra" and not row["repeat"]) if escalate else small
        routed = dict(selected)
        if escalate:
            escalated.append(case_id)
            routed["durationMs"] += small["durationMs"]
            routed["usage"] = {key: selected["usage"].get(key, 0) + small["usage"].get(key, 0) for key in selected["usage"]}
        cascade.append(routed)
    result = {
        "run": str(args.run), "arms": arms, "rows": rows,
        "cascade": {"type": "offline_simulation", "modelCalls": 16 + len(escalated), "escalatedCases": escalated, "summary": summary(cascade)},
    }
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"arms": arms, "cascade": result["cascade"]}, indent=2))


if __name__ == "__main__":
    main()
