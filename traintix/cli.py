from __future__ import annotations

import argparse
import sys

from .fares import FareData, Station


def pick(data: FareData, query: str) -> Station:
    hits = data.find_station(query)
    if not hits:
        sys.exit(f"No station matches {query!r}")
    if len(hits) > 1 and hits[0].name.lower() != query.lower() \
            and hits[0].crs.lower() != query.lower():
        print(f"'{query}' is ambiguous, using {hits[0].name} ({hits[0].crs}). "
              f"Others: {', '.join(h.name for h in hits[1:6])}", file=sys.stderr)
    return hits[0]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="traintix",
                                description="UK rail fares from the free RDG dataset")
    p.add_argument("--data", default="data", help="folder with the unzipped RDG feed")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("stations", help="search stations by name or CRS code")
    s.add_argument("query")

    f = sub.add_parser("fares", help="list fares between two stations")
    f.add_argument("origin")
    f.add_argument("dest")

    sp = sub.add_parser("split", help="find the cheapest split-ticket combination")
    sp.add_argument("stops", nargs="+",
                    help="origin, intermediate stops the train calls at, destination")
    args = p.parse_args(argv)

    try:
        data = FareData.load(args.data)
    except FileNotFoundError as e:
        sys.exit(str(e))

    if args.cmd == "stations":
        for st in data.find_station(args.query)[:20]:
            print(f"{st.crs or '---':4} {st.name}")
    elif args.cmd == "fares":
        a, b = pick(data, args.origin), pick(data, args.dest)
        rows = data.fares_between(a, b)
        if not rows:
            sys.exit(f"No fares found {a.name} -> {b.name}")
        print(f"{a.name} -> {b.name}")
        for r in rows:
            print(f"  {r.pounds:>8}  {r.label} [{r.ticket}] restriction {r.restriction}")
        print("\nAdvance fares are not in this dataset - check the operator's site.")
    elif args.cmd == "split":
        if len(args.stops) < 2:
            sys.exit("Give at least an origin and destination")
        stops = [pick(data, s) for s in args.stops]
        whole = data.cheapest(stops[0], stops[-1])
        res = data.best_split(stops)
        if res is None:
            sys.exit("No fares found for one of the legs")
        total, legs = res
        for a, b, fare in legs:
            print(f"  {a.name} -> {b.name}: {fare.pounds} {fare.label}")
        print(f"Total {total / 100:.2f}")
        if whole:
            print(f"Through ticket cheapest: {whole.pounds} "
                  f"(saving £{(whole.pence - total) / 100:.2f})")
        print("Check the train calls at every split station and that ticket "
              "restrictions allow it.")


if __name__ == "__main__":
    main()
