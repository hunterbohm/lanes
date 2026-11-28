#!/usr/bin/env bash
# Builds the tagged HEAD as a Developer ID signed, Apple-notarized Lanes-<tag>.zip and publishes it.
# Usage: app/release.sh [--no-upload]
# Run it on a Mac with the Developer ID certificate in its keychain, under `infisical run --env=prod --` (RELEASING.md):
#   HEREBY_SIGN_IDENTITY   the certificate's name, "Developer ID Application: <company> (<team id>)"
#   HEREBY_TEAM_ID         the ten-character team id; installed apps accept updates signed only by this team
#   Notarization, one of:  HEREBY_NOTARY_PROFILE (a `notarytool store-credentials` keychain profile), or
#                          HEREBY_NOTARY_KEY (the App Store Connect API key's .p8 text), HEREBY_NOTARY_KEY_ID, HEREBY_NOTARY_ISSUER
# It writes Lanes-<tag>.zip to app/build/release-out/<tag>, then attaches it to the GitHub release of the tag
# (creating it if needed). Installed apps offer whatever GitHub marks as the latest release. --no-upload stops
# after the zip is built and checked.
set -euo pipefail
umask 022
upload=1
for argument in "$@"; do
    case "$argument" in
        --no-upload) upload=0 ;;
        *) printf 'usage: release.sh [--no-upload]\n' >&2; exit 2 ;;
    esac
done
app_dir="$(cd "$(dirname "$0")" && pwd)"
bundle_id=io.github.hunterbohm.lanes

if ! version="$(git -C "$app_dir" describe --tags --exact-match HEAD 2>/dev/null)" || [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'A release needs HEAD on a release tag like v1.0.0.\n' >&2
    exit 1
fi
if [[ -n "$(git -C "$app_dir" status --porcelain --untracked-files=no)" ]]; then
    printf 'Not releasing: the clone has uncommitted changes, so the build would not match %s.\n' "$version" >&2
    exit 1
fi
missing=()
for name in HEREBY_SIGN_IDENTITY HEREBY_TEAM_ID; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
done
if [[ -z "${HEREBY_NOTARY_PROFILE:-}" ]]; then
    for name in HEREBY_NOTARY_KEY HEREBY_NOTARY_KEY_ID HEREBY_NOTARY_ISSUER; do
        [[ -n "${!name:-}" ]] || missing+=("$name (or HEREBY_NOTARY_PROFILE)")
    done
fi
if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'Not releasing: missing %s. Run it under `infisical run --env=prod --`; see RELEASING.md.\n' "${missing[*]}" >&2
    exit 1
fi
if [[ ! "$HEREBY_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then printf 'HEREBY_TEAM_ID is not a team id.\n' >&2; exit 1; fi
if [[ "$HEREBY_SIGN_IDENTITY" != "Developer ID Application: "*"($HEREBY_TEAM_ID)" ]]; then
    printf 'HEREBY_SIGN_IDENTITY must be a Developer ID Application certificate of team %s.\n' "$HEREBY_TEAM_ID" >&2
    exit 1
fi
if ! security find-identity -v -p codesigning | grep -qF "\"$HEREBY_SIGN_IDENTITY\""; then
    printf 'No valid "%s" in the keychain. See RELEASING.md.\n' "$HEREBY_SIGN_IDENTITY" >&2
    exit 1
fi

out="${LANES_RELEASE_OUT:-$app_dir/build/release-out/$version}"
rm -rf "$out"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
app="$work/Lanes.app"
zip="$out/Lanes-$version.zip"

"$app_dir/assemble.sh" "$app" "${version#v}"
plutil -replace LanesTeamID -string "$HEREBY_TEAM_ID" "$app/Contents/Info.plist"

# Hardened runtime and a secure timestamp are what notarization requires. One identity and one bundle id for every
# release is what lets an update meet the running app's requirement.
codesign --force --timestamp --options runtime --sign "$HEREBY_SIGN_IDENTITY" --identifier "$bundle_id" "$app"
requirement="anchor apple generic and identifier \"$bundle_id\" and certificate leaf[subject.OU] = \"$HEREBY_TEAM_ID\""
codesign --verify --deep --strict -R "=$requirement" "$app"

ditto -c -k --keepParent "$app" "$work/notarize.zip"
notary=()
if [[ -n "${HEREBY_NOTARY_PROFILE:-}" ]]; then
    notary=(--keychain-profile "$HEREBY_NOTARY_PROFILE")
else
    # %b: secret stores that keep one-line values hold the .p8's line breaks as literal \n.
    (umask 077; printf '%b\n' "$HEREBY_NOTARY_KEY" > "$work/notary.p8")
    notary=(--key "$work/notary.p8" --key-id "$HEREBY_NOTARY_KEY_ID" --issuer "$HEREBY_NOTARY_ISSUER")
fi
printf 'Notarizing %s; Apple usually answers in a few minutes.\n' "$version"
xcrun notarytool submit "$work/notarize.zip" "${notary[@]}" --wait --output-format json > "$work/notary.json" || true
status="$(plutil -extract status raw -o - "$work/notary.json" 2>/dev/null || true)"
if [[ "$status" != "Accepted" ]]; then
    submission="$(plutil -extract id raw -o - "$work/notary.json" 2>/dev/null || true)"
    printf 'Notarization ended as "%s".\n' "${status:-unknown}" >&2
    [[ -n "$submission" ]] && xcrun notarytool log "$submission" "${notary[@]}" >&2 || true
    exit 1
fi
xcrun stapler staple "$app"
xcrun stapler validate "$app"
if ! spctl --assess --type execute -vv "$app" 2>&1 | tee "$work/spctl.txt" | grep -q 'source=Notarized Developer ID'; then
    cat "$work/spctl.txt" >&2
    printf 'macOS does not accept the app as a notarized Developer ID app.\n' >&2
    exit 1
fi

ditto -c -k --keepParent "$app" "$zip"
printf 'Built %s\n' "$zip"
[[ $upload == 1 ]] || exit 0

notes="Signed and notarized build of $version. Download Lanes-$version.zip, unzip it, and move Lanes.app to ~/Applications. Installed copies offer this update from the right-click menu."
if gh release view "$version" >/dev/null 2>&1; then
    gh release upload "$version" "$zip" --clobber
else
    gh release create "$version" "$zip" --verify-tag --title "$version" --notes "$notes" --latest
fi
printf 'Published %s; installed apps offer it within a day.\n' "$version"
