# traintix

A free, personal-use tool for looking up UK rail fares and finding cheaper
split-ticket combinations, built on the Rail Delivery Group (RDG) fares dataset.
Pure Python 3.10+, no dependencies.

## Setup

1. Register (free) at https://raildata.org.uk and download the **Fares** dataset.
2. Unzip it into `./data/` (you need the `.LOC`, `.FSC` and `.FFL` files).

## Usage

```
python -m traintix stations "kings cross"
python -m traintix fares KGX YRK
python -m traintix split KGX PBO DON YRK     # origin, stops the train calls at, destination
```

`split` finds the cheapest way to cover the journey with one or more tickets.
You list the stations the train actually calls at: the dataset has no timetable,
so check that the train stops at each split point.

## Limits

- **Advance fares are not in the open dataset.** This covers Anytime, Off-Peak
  and Super Off-Peak style fares. For Advance, check the operator's site.
- Railcard discounts, ticket restrictions and route validity are not applied yet.
- The file parser follows the RDG spec (RSPS5045) and is tested against
  synthetic data only. Not yet run against a real download, so field offsets in
  `traintix/fares.py` may need adjusting.

## Tests

```
python -m unittest discover -s tests
```
