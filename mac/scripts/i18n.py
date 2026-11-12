#!/usr/bin/env python3
"""String Catalog helper for the Mac app (mac/Untether/Localizable.xcstrings).

xcodebuild never writes extracted strings back into the source catalog (only the Xcode
app does), so `i18n-sync.sh` runs `xcstringstool sync` and then this script:

  annotate <dir>   Gives keys without a code comment one naming where they are used
                   (from the build's .stringsdata in <dir>), and marks keys only used in
                   Xcode previews as not translatable.
  plurals          Adds English plural variations for count keys (PLURALS below), so
                   translators fill every plural category of their language.
  check [--strict] Verifies every key has a comment, placeholders survive translation and
                   plural keys cover each language's categories. --strict also fails on
                   missing translations.
  export <lang>    Prints a JSON template for translators (see TRANSLATING below).
  merge <file>...  Writes translator JSON fragments into the catalog.

TRANSLATING: a fragment is one JSON object per language:

  {
    "language": "es",
    "strings": {
      "Open Dashboard": "Abrir panel",
      "%lld need you": {"one": "%lld te necesita", "other": "%lld te necesitan"},
      "%@, %lld sessions need you": {"arg": 2, "one": "%arg sesión te necesita",
                                     "other": "%arg sesiones te necesitan",
                                     "value": "%1$@, %#@arg2@"}
    }
  }

Plain keys map to a string. Plural keys map to an object with the language's CLDR
categories (zero/one/two/few/many/other); for keys with several placeholders the object
names the counted argument ("arg") and the full sentence ("value") that embeds it as
%#@arg<N>@, and the variations use %arg for the number. Placeholders (%@, %lld, %d,
%1$@...) must appear in the translation exactly as in the key.
"""

import json
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = Path(os.environ.get("I18N_CATALOG", ROOT / "Untether" / "Localizable.xcstrings"))
LANGUAGES = ["es", "fr", "pt-BR", "zh-Hans", "ar", "bn", "hi"]

# CLDR plural categories used by Foundation for integer counts.
PLURAL_CATEGORIES = {
    "en": ["one", "other"],
    "es": ["one", "many", "other"],
    "fr": ["one", "many", "other"],
    "pt-BR": ["one", "many", "other"],
    "zh-Hans": ["other"],
    "ar": ["zero", "one", "two", "few", "many", "other"],
    "bn": ["one", "other"],
    "hi": ["one", "other"],
}

# Count keys: key -> (counted argument number or None for a single-argument key,
#                     English "one", English "other"). Substitution forms use %arg.
PLURALS = {
    "%lld need you": (None, "%lld needs you", "%lld need you"),
    "%lld working": (None, "%lld working", "%lld working"),
    "%lld idle": (None, "%lld idle", "%lld idle"),
    "%lld other": (None, "%lld other", "%lld other"),
    "tooltip.count.needsYou": (None, "%lld needs you", "%lld need you"),
    "tooltip.count.working": (None, "%lld working", "%lld working"),
    "tooltip.count.idle": (None, "%lld idle", "%lld idle"),
    "tooltip.count.running": (None, "%lld running", "%lld running"),
    "tooltip.count.exited": (None, "%lld exited", "%lld exited"),
    "%@, %lld sessions need you": (2, "%arg session needs you", "%arg sessions need you"),
    "%@, %lld sessions": (2, "%arg session", "%arg sessions"),
    "%@, %lld sessions, collapsed": (2, "%arg session, collapsed", "%arg sessions, collapsed"),
    "%lld sessions: %@": (1, "%arg session", "%arg sessions"),
    "And %lld more": (None, "And %lld more", "And %lld more"),
    "%lld active sessions": (None, "%lld active session", "%lld active sessions"),
    "%@ and %lld more": (2, "%arg more", "%arg more"),
    "%lld repositories found.": (None, "%lld repository found.", "%lld repositories found."),
    "%lld min ago": (None, "%lld min ago", "%lld min ago"),
    "%lld h ago": (None, "%lld h ago", "%lld h ago"),
    "%lld d ago": (None, "%lld d ago", "%lld d ago"),
    "The server crashed %lld times in a row": (None, "The server crashed %lld time in a row", "The server crashed %lld times in a row"),
    "It crashed %lld times in a row. Untether keeps retrying every minute — see logs.": (
        None,
        "It crashed %lld time in a row. Untether keeps retrying every minute — see logs.",
        "It crashed %lld times in a row. Untether keeps retrying every minute — see logs.",
    ),
}

PLACEHOLDER = re.compile(r"%(?:\d+\$)?(?:lld|ld|d|@|f|\.\df|s|#@\w+@)")


def load():
    return json.loads(CATALOG.read_text(), object_pairs_hook=OrderedDict)


def save(catalog):
    text = json.dumps(catalog, ensure_ascii=False, indent=2, separators=(",", " : "))
    CATALOG.write_text(text + "\n")


def placeholders(text):
    """Placeholders without positions, in order: '%1$@' and '%@' compare equal."""
    return sorted(re.sub(r"\d+\$", "", p) for p in PLACEHOLDER.findall(text) if "#@" not in p)


def source_value(key, entry):
    unit = entry.get("localizations", {}).get("en", {}).get("stringUnit")
    return unit["value"] if unit else key


def plural_unit(categories):
    return OrderedDict(
        (cat, {"stringUnit": {"state": "translated", "value": value}}) for cat, value in categories.items()
    )


def cmd_plurals():
    catalog = load()
    strings = catalog["strings"]
    missing = []
    for key, (arg, one, other) in PLURALS.items():
        entry = strings.get(key)
        if entry is None:
            missing.append(key)
            continue
        loc = entry.setdefault("localizations", OrderedDict())
        if arg is None:
            loc["en"] = {"variations": {"plural": plural_unit({"one": one, "other": other})}}
        else:
            value = ENGLISH_SUBSTITUTION_VALUES[key]
            spec = PLACEHOLDER.findall(key)[arg - 1].lstrip("%")
            spec = re.sub(r"^\d+\$", "", spec)
            loc["en"] = OrderedDict(
                [
                    ("stringUnit", {"state": "translated", "value": value}),
                    (
                        "substitutions",
                        {
                            "arg{}".format(arg): OrderedDict(
                                [
                                    ("argNum", arg),
                                    ("formatSpecifier", spec),
                                    ("variations", {"plural": plural_unit({"one": one, "other": other})}),
                                ]
                            )
                        },
                    ),
                ]
            )
    save(catalog)
    if missing:
        print("plurals: keys not in the catalog (renamed in code?):", *missing, sep="\n  ", file=sys.stderr)
        return 1
    print("plurals: {} keys with English plural variations".format(len(PLURALS)))
    return 0


# Full English sentence for multi-argument plural keys; %#@argN@ is the counted part.
ENGLISH_SUBSTITUTION_VALUES = {
    "%@, %lld sessions need you": "%1$@, %#@arg2@",
    "%@, %lld sessions": "%1$@, %#@arg2@",
    "%@, %lld sessions, collapsed": "%1$@, %#@arg2@",
    "%lld sessions: %@": "%#@arg1@: %2$@",
    "%@ and %lld more": "%1$@ and %#@arg2@",
}


def iter_units(localization):
    """(label, value) for every string a localization holds, plural forms included."""
    if "stringUnit" in localization:
        yield "value", localization["stringUnit"]["value"]
    for cat, unit in localization.get("variations", {}).get("plural", {}).items():
        yield cat, unit["stringUnit"]["value"]
    for name, sub in localization.get("substitutions", {}).items():
        for cat, unit in sub.get("variations", {}).get("plural", {}).items():
            yield "{}.{}".format(name, cat), unit["stringUnit"]["value"]


def cmd_check(strict):
    catalog = load()
    problems = []
    missing = {lang: 0 for lang in LANGUAGES}
    for key, entry in catalog["strings"].items():
        if entry.get("shouldTranslate") is False:
            continue
        if not entry.get("comment") and not entry.get("extractionState") == "stale":
            problems.append("no comment: {!r}".format(key))
        source = source_value(key, entry)
        if key in PLURALS and PLURALS[key][0] is None:
            # Identifier keys (tooltip.count.*) have only English plural forms; the key
            # itself carries no placeholders, so compare against the English form.
            source = PLURALS[key][2]
        expected = placeholders(source if "#@" not in source else key)
        for lang in LANGUAGES:
            loc = entry.get("localizations", {}).get(lang)
            if not loc:
                missing[lang] += 1
                continue
            is_plural = "variations" in loc or "substitutions" in loc
            if key in PLURALS and not is_plural and PLURAL_CATEGORIES[lang] != ["other"]:
                problems.append("{}: plural key without plural forms: {!r}".format(lang, key))
            for label, value in iter_units(loc):
                if "." in label or ("#@" in value):
                    continue  # substitution pieces carry %arg, checked below
                if placeholders(value) != expected:
                    problems.append("{}: placeholders differ in {!r} ({}): {!r}".format(lang, key, label, value))
            plural = loc.get("variations", {}).get("plural")
            if plural is not None:
                gaps = [c for c in PLURAL_CATEGORIES[lang] if c not in plural]
                if gaps:
                    problems.append("{}: plural {!r} lacks {}".format(lang, key, ", ".join(gaps)))
            for name, sub in loc.get("substitutions", {}).items():
                forms = sub.get("variations", {}).get("plural", {})
                gaps = [c for c in PLURAL_CATEGORIES[lang] if c not in forms]
                if gaps:
                    problems.append("{}: substitution {} of {!r} lacks {}".format(lang, name, key, ", ".join(gaps)))
                for cat, unit in forms.items():
                    if "%arg" not in unit["stringUnit"]["value"] and lang != "zh-Hans":
                        problems.append("{}: {}.{} of {!r} doesn't use %arg".format(lang, name, cat, key))
    total = len(catalog["strings"])
    print("check: {} keys".format(total))
    for lang in LANGUAGES:
        print("  {:8} {:4} missing".format(lang, missing[lang]))
    for problem in problems:
        print("  " + problem, file=sys.stderr)
    failed = bool(problems) or (strict and any(missing.values()))
    return 1 if failed else 0


def cmd_export(lang):
    catalog = load()
    out = OrderedDict([("language", lang), ("strings", OrderedDict())])
    notes = OrderedDict()
    for key, entry in catalog["strings"].items():
        if entry.get("shouldTranslate") is False or entry.get("extractionState") == "stale":
            continue
        cats = PLURAL_CATEGORIES[lang]
        if key in PLURALS:
            arg = PLURALS[key][0]
            template = OrderedDict((c, "") for c in cats)
            if arg is not None:
                template["arg"] = arg
                template["value"] = ENGLISH_SUBSTITUTION_VALUES[key]
            out["strings"][key] = template
        else:
            out["strings"][key] = ""
        notes[key] = OrderedDict(
            [("english", source_value(key, entry) if key not in PLURALS else PLURALS[key][1:]), ("comment", entry.get("comment", ""))]
        )
    out["_notes"] = notes
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_merge(paths):
    catalog = load()
    strings = catalog["strings"]
    errors = 0
    for path in paths:
        fragment = json.loads(Path(path).read_text())
        lang = fragment["language"]
        if lang not in LANGUAGES:
            print("merge: unknown language {!r} in {}".format(lang, path), file=sys.stderr)
            return 1
        for key, value in fragment["strings"].items():
            if key not in strings:
                print("merge: {} has unknown key {!r}".format(lang, key), file=sys.stderr)
                errors += 1
                continue
            if value in ("", None) or (isinstance(value, dict) and not any(v for k, v in value.items() if k not in ("arg", "value"))):
                continue
            loc = strings[key].setdefault("localizations", OrderedDict())
            if isinstance(value, str):
                loc[lang] = {"stringUnit": {"state": "translated", "value": value}}
                continue
            forms = OrderedDict((c, value[c]) for c in PLURAL_CATEGORIES[lang] if value.get(c))
            arg = value.get("arg")
            if arg is None:
                loc[lang] = {"variations": {"plural": plural_unit(forms)}}
            else:
                spec = re.sub(r"^%?(\d+\$)?", "", PLACEHOLDER.findall(key)[arg - 1])
                loc[lang] = OrderedDict(
                    [
                        ("stringUnit", {"state": "translated", "value": value.get("value") or ENGLISH_SUBSTITUTION_VALUES[key]}),
                        (
                            "substitutions",
                            {
                                "arg{}".format(arg): OrderedDict(
                                    [("argNum", arg), ("formatSpecifier", spec), ("variations", {"plural": plural_unit(forms)})]
                                )
                            },
                        ),
                    ]
                )
    save(catalog)
    print("merge: wrote {} fragment(s)".format(len(paths)))
    return 1 if errors else 0


AREAS = [
    ("Presentation/Components/Menu/", "Menu bar"),
    ("Presentation/Components/StatusBar", "Menu bar icon"),
    ("Presentation/Components/TooltipProvider", "Menu bar icon tooltip"),
    ("Presentation/Components/UntetherMenuView", "Menu bar"),
    ("Presentation/Components/NewSessionForm", "New session form"),
    ("Presentation/Components/GitBranchWorktreeSelector", "New session form, branch picker"),
    ("Presentation/Components/WorktreeSelectionView", "New session form, worktree picker"),
    ("Presentation/Components/ClickableURLView", "Address row"),
    ("Presentation/Views/Settings/GeneralSettingsView", "Settings, General"),
    ("Presentation/Views/Settings/LanguageSettingsSection", "Settings, General, Language"),
    ("Presentation/Views/Settings/AppPreferenceSections", "Settings, General, Apps"),
    ("Presentation/Views/Settings/CLIInstallationSection", "Settings, General, Command Line Tool"),
    ("Presentation/Views/Settings/PermissionsSection", "Settings, General, Permissions"),
    ("Presentation/Views/Settings/SessionsSettingsView", "Settings, Sessions"),
    ("Presentation/Views/Settings/RepositorySettingsSection", "Settings, Sessions"),
    ("Presentation/Views/Settings/NotificationSettingsView", "Settings, Notifications"),
    ("Presentation/Views/Settings/DashboardSettingsView", "Settings, Server"),
    ("Presentation/Views/Settings/ServerConfigurationComponents", "Settings, Server"),
    ("Presentation/Views/Settings/RemoteAccessSettingsView", "Settings, Remote Access"),
    ("Presentation/Views/Settings/CloudflareIntegrationSection", "Settings, Remote Access, Cloudflare"),
    ("Presentation/Views/Settings/PinggyIntegrationSection", "Settings, Remote Access, Pinggy"),
    ("Presentation/Views/Settings/PangolinIntegrationSection", "Settings, Remote Access, Pangolin"),
    ("Presentation/Views/Settings/AuthenticationSection", "Settings, Remote Access, Authentication"),
    ("Presentation/Views/Settings/DebugSettingsView", "Settings, Debug"),
    ("Presentation/Views/Welcome/", "Welcome window"),
    ("Presentation/Views/WelcomeView", "Welcome window"),
    ("Presentation/Views/AboutView", "Settings, About"),
    ("Presentation/Views/SessionDetailView", "Session Details window"),
    ("Presentation/DesignSystem/", "Shared control"),
]


def area_for(path):
    for prefix, area in AREAS:
        if prefix in path:
            return area
    return "App"


def preview_ranges(source):
    """Line ranges of #Preview { ... } blocks in a Swift file."""
    ranges = []
    try:
        lines = Path(source).read_text().split("\n")
    except OSError:
        return ranges
    start = None
    depth = 0
    for number, line in enumerate(lines, 1):
        if start is None and line.lstrip().startswith("#Preview"):
            start, depth = number, 0
        if start is not None:
            depth += line.count("{") - line.count("}")
            if depth <= 0 and "}" in line:
                ranges.append((start, number))
                start = None
    return ranges


def cmd_annotate(directory):
    catalog = load()
    strings = catalog["strings"]
    uses = {}
    previews = {}
    for path in Path(directory).rglob("*.stringsdata"):
        data = json.loads(path.read_text())
        source = data.get("source", "")
        if source not in previews:
            previews[source] = preview_ranges(source)
        for items in data.get("tables", {}).values():
            for item in items:
                line = item.get("location", {}).get("startingLine", 0)
                in_preview = any(a <= line <= b for a, b in previews[source])
                uses.setdefault(item["key"], []).append((source, in_preview))
    annotated = 0
    for key, entry in strings.items():
        found = uses.get(key)
        if not found:
            continue
        if all(in_preview for _, in_preview in found):
            entry["shouldTranslate"] = False
            entry["comment"] = "Xcode preview only"
            continue
        if entry.get("comment"):
            continue
        areas = []
        for source, in_preview in found:
            if in_preview:
                continue
            label = "{} ({})".format(area_for(source), Path(source).name)
            if label not in areas:
                areas.append(label)
        entry["comment"] = "; ".join(areas)
        annotated += 1
    save(catalog)
    print("annotate: {} keys got a location comment".format(annotated))
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    command = argv[1]
    if command == "annotate" and len(argv) == 3:
        return cmd_annotate(argv[2])
    if command == "plurals":
        return cmd_plurals()
    if command == "check":
        return cmd_check("--strict" in argv[2:])
    if command == "export" and len(argv) == 3:
        return cmd_export(argv[2])
    if command == "merge" and len(argv) >= 3:
        return cmd_merge(argv[2:])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
