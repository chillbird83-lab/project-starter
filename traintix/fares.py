"""Parser and lookup for the RDG fares feed (fixed-width flat files).

Files used (all from the same feed download, sharing one filename stem):
  *.LOC  stations      *.FSC  station clusters (e.g. "London Terminals")
  *.FFL  flows + fares *.RLC  railcards (not yet used)

Only records whose end date is 31122999 (still valid) are kept.
"""
from __future__ import annotations

import glob
import os
from collections import defaultdict
from dataclasses import dataclass

OPEN_END = "31122999"

# Common ticket codes; the full list lives in the feed's .TTY file.
TICKET_NAMES = {
    "SOR": "Anytime Single",
    "SDS": "Anytime Day Single",
    "SOS": "Off-Peak Single",
    "SVS": "Off-Peak Day Single",
    "SSS": "Super Off-Peak Single",
    "CDS": "Off-Peak Day Single (cheap)",
    "SVR": "Off-Peak Day Return",
    "SDR": "Anytime Day Return",
    "CDR": "Cheap Day Return",
    "SSR": "Super Off-Peak Return",
}


@dataclass(frozen=True)
class Station:
    nlc: str
    name: str
    crs: str


@dataclass(frozen=True)
class Fare:
    ticket: str
    pence: int
    restriction: str
    toc: str

    @property
    def pounds(self) -> str:
        return f"£{self.pence / 100:.2f}"

    @property
    def label(self) -> str:
        return TICKET_NAMES.get(self.ticket, self.ticket)


def _find(folder: str, ext: str) -> str | None:
    hits = glob.glob(os.path.join(folder, f"*.{ext}")) + glob.glob(
        os.path.join(folder, f"*.{ext.lower()}"))
    return hits[0] if hits else None


def _lines(path: str):
    with open(path, encoding="latin-1") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if line and not line.startswith("/"):
                yield line


class FareData:
    def __init__(self) -> None:
        self.stations: dict[str, Station] = {}          # nlc -> Station
        self.clusters: dict[str, set[str]] = defaultdict(set)  # nlc -> cluster ids
        # (origin, dest) -> list of (flow_id, toc); reverse flows stored flipped
        self.flows: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
        self.fares: dict[str, list[Fare]] = defaultdict(list)  # flow_id -> fares

    # ---- loading -------------------------------------------------------
    @classmethod
    def load(cls, folder: str) -> "FareData":
        d = cls()
        loc, fsc, ffl = (_find(folder, e) for e in ("LOC", "FSC", "FFL"))
        if not (loc and ffl):
            raise FileNotFoundError(
                f"No .LOC and .FFL files found in {folder!r}. See README for "
                "how to download the RDG fares feed.")
        d._load_locations(loc)
        if fsc:
            d._load_clusters(fsc)
        d._load_flows(ffl)
        return d

    def _load_locations(self, path: str) -> None:
        for line in _lines(path):
            if line[1:2] != "L" or line[0] == "D":
                continue
            if line[9:17] != OPEN_END:
                continue
            nlc, name, crs = line[36:40], line[40:56].strip(), line[56:59].strip()
            self.stations[nlc] = Station(nlc, name.title(), crs)

    def _load_clusters(self, path: str) -> None:
        for line in _lines(path):
            if line[0] == "D" or line[9:17] != OPEN_END:
                continue
            self.clusters[line[5:9]].add(line[1:5])

    def _load_flows(self, path: str) -> None:
        for line in _lines(path):
            if line[0] == "D":
                continue
            kind = line[1:2]
            if kind == "F":
                if line[20:28] != OPEN_END:
                    continue
                origin, dest = line[2:6], line[6:10]
                direction, toc, fid = line[19], line[36:39], line[42:49]
                self.flows[(origin, dest)].append((fid, toc))
                if direction == "R":
                    self.flows[(dest, origin)].append((fid, toc))
            elif kind == "T":
                self.fares[line[2:9]].append(
                    Fare(line[9:12], int(line[12:20]), line[20:22], ""))

    # ---- lookup --------------------------------------------------------
    def find_station(self, query: str) -> list[Station]:
        q = query.strip().lower()
        exact = [s for s in self.stations.values() if s.crs.lower() == q]
        if exact:
            return exact
        return sorted((s for s in self.stations.values() if q in s.name.lower()),
                      key=lambda s: (len(s.name), s.name))

    def _codes(self, nlc: str) -> set[str]:
        # A flow may name the station itself or a cluster containing it.
        return {nlc} | self.clusters.get(nlc, set())

    def fares_between(self, a: Station, b: Station) -> list[Fare]:
        out: dict[tuple[str, str], Fare] = {}
        for o in self._codes(a.nlc):
            for d in self._codes(b.nlc):
                for fid, toc in self.flows.get((o, d), []):
                    for f in self.fares.get(fid, []):
                        key = (f.ticket, f.restriction)
                        if key not in out or f.pence < out[key].pence:
                            out[key] = Fare(f.ticket, f.pence, f.restriction, toc)
        return sorted(out.values(), key=lambda f: f.pence)

    def cheapest(self, a: Station, b: Station, tickets: set[str] | None = None):
        fares = [f for f in self.fares_between(a, b)
                 if tickets is None or f.ticket in tickets]
        return fares[0] if fares else None

    def best_split(self, stops: list[Station], tickets: set[str] | None = None):
        """Cheapest way to cover the ordered `stops` with one or more tickets.

        Dynamic programming over every contiguous sub-journey. Returns
        (total_pence, [(from, to, Fare), ...]) or None if a leg has no fare.
        `stops` must be the stations you actually pass, in order; split
        tickets are only valid if the train calls at each split point.
        """
        n = len(stops)
        best: list[tuple[int, list] | None] = [None] * n
        best[0] = (0, [])
        for j in range(1, n):
            for i in range(j):
                if best[i] is None:
                    continue
                f = self.cheapest(stops[i], stops[j], tickets)
                if f is None:
                    continue
                total = best[i][0] + f.pence
                if best[j] is None or total < best[j][0]:
                    best[j] = (total, best[i][1] + [(stops[i], stops[j], f)])
        return best[-1]
