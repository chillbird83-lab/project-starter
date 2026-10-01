import os
import tempfile
import unittest

from traintix.fares import FareData


def loc(nlc, name, crs):
    # marker, type, UIC(7), end, start, quote, admin(3), NLC(4), desc(16), CRS(3)
    return ("RL" + "0" * 7 + "31122999" + "01012020" + "01012020" + "ZZZ"
            + nlc + name.upper().ljust(16)[:16] + crs)


def flow(o, d, direction, toc, fid):
    return ("RF" + o + d + "00000" + "000" + "0" + direction + "31122999"
            + "01012020" + toc + "0" + "0" + "0" + fid)


def fare(fid, ticket, pence, restr="  "):
    return "RT" + fid + ticket + str(pence).rjust(8, "0") + restr


def build(folder):
    w = lambda n, rows: open(os.path.join(folder, n), "w").write("\n".join(rows) + "\n")
    w("RJFAF.LOC", [loc("1001", "A town", "AAA"), loc("1002", "B town", "BBB"),
                    loc("1003", "C town", "CCC"), "/ comment"])
    w("RJFAF.FSC", ["R" + "9999" + "1003" + "31122999" + "01012020"])
    w("RJFAF.FFL", [
        flow("1001", "1003", "R", "XXX", "0000001"),   # A-C through
        flow("1001", "1002", "R", "XXX", "0000002"),   # A-B
        flow("1002", "9999", "S", "XXX", "0000003"),   # B-cluster(C), one way
        fare("0000001", "SOR", 5000), fare("0000001", "SOS", 3000),
        fare("0000002", "SOR", 1000), fare("0000003", "SOR", 1500),
    ])


class FaresTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        build(self.tmp.name)
        self.d = FareData.load(self.tmp.name)
        self.a, self.b, self.c = (self.d.find_station(x)[0] for x in ("AAA", "BBB", "CCC"))

    def test_station_search(self):
        self.assertEqual(self.d.find_station("b tow")[0].crs, "BBB")

    def test_fares_sorted_and_reverse(self):
        self.assertEqual([f.pence for f in self.d.fares_between(self.a, self.c)], [3000, 5000])
        self.assertEqual(self.d.cheapest(self.c, self.a).pence, 3000)

    def test_one_way_flow_not_reversed(self):
        self.assertIsNone(self.d.cheapest(self.c, self.b))

    def test_cluster_expansion(self):
        self.assertEqual(self.d.cheapest(self.b, self.c).pence, 1500)

    def test_split_beats_through(self):
        total, legs = self.d.best_split([self.a, self.b, self.c])
        self.assertEqual(total, 2500)
        self.assertEqual(len(legs), 2)

    def test_split_keeps_through_when_cheaper(self):
        total, legs = self.d.best_split([self.a, self.c])
        self.assertEqual((total, len(legs)), (3000, 1))


if __name__ == "__main__":
    unittest.main()
