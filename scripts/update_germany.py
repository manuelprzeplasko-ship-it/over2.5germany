
import csv
import io
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Germany Over Lab 1.0
# D1 = Bundesliga
# D2 = 2. Bundesliga
# Sezony od 2021/22 do bieżącego 2026/27.

LEAGUES = {
    "D1": "Bundesliga",
    "D2": "2. Bundesliga",
}

SEASONS = ["2122", "2223", "2324", "2425", "2526", "2627"]

OUTPUT = Path("data/all_matches.json")


def download_csv(season, league):
    url = (
        "https://www.football-data.co.uk/"
        f"mmz4281/{season}/{league}.csv"
    )

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 GermanyOverLab/1.0"}
    )

    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()

    # Football-Data może używać różnych kodowań.
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding), url
        except UnicodeDecodeError:
            continue

    raise ValueError("Nie można odczytać kodowania CSV")


def parse_date(value):
    value = (value or "").strip()

    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass

    return None


def load_matches(season, league):
    content, url = download_csv(season, league)
    reader = csv.DictReader(io.StringIO(content))

    matches = []

    for row in reader:
        if not row:
            continue

        date = parse_date(row.get("Date"))
        home = (row.get("HomeTeam") or "").strip()
        away = (row.get("AwayTeam") or "").strip()
        home_goals = (row.get("FTHG") or "").strip()
        away_goals = (row.get("FTAG") or "").strip()

        if not all([date, home, away, home_goals, away_goals]):
            continue

        try:
            hg = int(home_goals)
            ag = int(away_goals)
        except ValueError:
            continue

        if hg < 0 or ag < 0:
            continue

        matches.append({
            "league": league,
            "date": date,
            "home": home,
            "away": away,
            "home_goals": hg,
            "away_goals": ag,
            "total_goals": hg + ag,
            "over25": hg + ag >= 3,
        })

    print(f"{league} {season}: {len(matches)} meczów | {url}")
    return matches


def main():
    all_matches = []
    failures = []

    for league in LEAGUES:
        for season in SEASONS:
            try:
                all_matches.extend(load_matches(season, league))
            except Exception as exc:
                message = f"{league} {season}: {exc}"
                failures.append(message)
                print("BŁĄD:", message)

    # Nie publikujemy niekompletnej bazy.
    if failures:
        raise RuntimeError(
            "Nie udało się pobrać wszystkich sezonów:\n"
            + "\n".join(failures)
        )

    unique = {}

    for match in all_matches:
        key = (
            match["league"],
            match["date"],
            match["home"],
            match["away"],
        )
        unique[key] = match

    result = sorted(
        unique.values(),
        key=lambda m: (
            m["date"],
            m["league"],
            m["home"],
            m["away"],
        ),
    )

    if not result:
        raise RuntimeError("Brak meczów. Baza nie została zapisana.")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Zapisano {len(result)} meczów do {OUTPUT}")
    print("Aktualizacja zakończona poprawnie.")


if __name__ == "__main__":
    main()
