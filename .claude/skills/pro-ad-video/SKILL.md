---
name: pro-ad-video
description: Make a professional short-form ad or social video (Reels/TikTok/Shorts 9:16 plus 16:9) that meets the house quality floor set by the UnitedSets Thanksgiving all-ages pilot, using the build -> QC gate -> review -> fix loop. Use for any tournament ad, program promo, recap or donor video before it is shown to the user or posted.
---

# Pro ad video: the floor and the loop

The UnitedSets Thanksgiving all-ages 30s ad (Nov 2026) is the **floor**. Nothing ships below it.
Reference build: `tools/ad-builder/build_ad.py`. Quality gate: `tools/video-qc/qc.py`.

## 1. The floor (every video, every format)

**Hook (first 0.5 s)**
- A person in motion on the first frame: mid-swing, mid-stride. Never an empty court or a logo.
- On-screen text and voice both start within 0.5 s.

**Shots**
- 1.2 to 2.2 s average and nothing over 3.5 s, except the end card and the photo stack.
- Every shot answers its voice line *literally*. If the line is a metaphor ("leftovers can wait"), use licensed b-roll of exactly that (a fridge full of food), not a random rally.
- People on screen in every footage shot. No empty-venue shots; the venue is the background *behind* a player.
- Don't use the same player in more than 2 shots in a row, or more than 3 in the whole ad.
- Crop to the subject. The upscale must be ≤ 1.8× (a portrait 4K phone source allows about 1.5× on 9:16).
- The subject is fully in frame from the first frame of the shot: start the shot after they enter.
- Nothing static for more than 0.8 s. Push in on clips, stills and cards (cards get a slow push-in plus a breathing vignette).
- At least 3 transition types. Hard cuts on the beat; whip/slide on topic changes; a white flash into photo stacks and payoffs.

**Venue (events on clay, like UnitedSets at Oak Lane)**
- Every shot that reads as a place (hook, venue, wide rally, handshake) is on the event's surface: Oak Lane green clay.
- Hard-court footage may appear only as **inserts that hide the floor**: waist-up or tighter crops, contact close-ups, faces and reactions; cut-outs on brand backgrounds; teal-duotone flash cuts; split screens. Insert length 0.5–1.2 s, always cut between clay shots. Crop out sponsor banners and venue signage too.
- Footage shots set `kind: 'clip'`; graphic treatments set `kind: 'graphic'`. The QC gate fails any `clip` shot showing more than 6% hard-court blue when the sidecar has `surface: 'clay'`.
- Use inserts to give every ad different players and angles, so a campaign never repeats the same few clips.

**Text**
- Montserrat ExtraBold, slanted, white with one lime keyword per line (`#D4F03C`). Teal is `#014A62`.
- Slam text is ≥ 90 px on 9:16, pops in at 135% → 100%, and never sits over a face.
- 9:16 safe zone: y 280–1500, 60 px side margins. 16:9: 60 px all round.
- Emoji: one per beat at most, drawn from Noto Color Emoji at full size. Give it a soft white glow if it sits on a busy or same-colored background. Use falling leaves 🍂, not a turkey.

**Brand**
- Logo badge (cut out from the white background) top-left on every shot, plus a short label ("OAK LANE · THANKSGIVING").
- End card ≥ 2.5 s: big logo, the CTA date line in lime, two fact lines, and a "LINK IN BIO" pill. A 16:9 end card also gets a QR code once the entry URL is known.

**Sound**
- Every voice line is audible and nothing is clipped at either end. Cut lines with `atrim` + `asetpts=PTS-STARTPTS` *before* any fade. A fade timed on the source clock silenced 8 of 10 lines once.
- Voice sits ≥ 6 dB above the effects.
- Effects: a hit pop on visible contact, a whoosh or whip on transitions, a shutter on each photo, a tick under countdowns, and a boom on payoffs and the end card. A record scratch on the holiday gag.
- No music unless the user asks: platform audio is added in-app for organic posts.
- Two-pass loudnorm to −14 LUFS, true peak ≤ −1.5 dBTP.

**Compliance**
- No player names anywhere. No price. Only licensed stock (Unsplash is fine for ads). Flag any visible third-party brands before a paid boost.

## 2. The loop (never skip a step)

1. **Brief.** Script lines, audience, CTA, posting days and the variants they need (countdown numbers).
2. **Clip sheet.** One still per shot, framed exactly as it will appear, with its line and source. **The user approves it before any render.**
3. **Build.** Shots are cached by content, and the ad is rendered in sections split at hard cuts. Sections are joined with stream copy, so an edit re-renders only what changed. Each render writes a `.qc.json` sidecar.
4. **QC gate.** `python3 tools/video-qc/qc.py <video> --frames review.jpg --log qc-log.csv`
   - Any HARD failure means **do not show it to the user**. Fix it first.
   - Score < 90 means fix the soft failures first; 85 is the absolute floor.
5. **Eyes-on review** of `review.jpg` (one frame per shot) and the first and last second, against the visual checklist below. Write down every miss and fix it.
6. **Fix and rebuild.** Only the changed sections re-render. Go back to step 4.
7. **Deliver.** Send the 9:16 first, then all variants, the post kit and the scorecard.
8. **Learn.** After posting, add the 3-second hold %, average watch %, shares and link clicks to `qc-log.csv`. Change this skill when the data says something works.

### Visual checklist (step 5)
- [ ] First frame: a person mid-action, fully in frame.
- [ ] Every shot: the subject is readable at phone size, and no face is under text.
- [ ] Every b-roll matches its line literally.
- [ ] No same subject 3 times in a row; venue shots include a player.
- [ ] Color looks consistent between sources (dome footage, photos, stock).
- [ ] The logo is visible on every shot; the end card reads in 1 second.
- [ ] Nothing would embarrass the org if it were the thumbnail.

## 3. Raising the ceiling (try one per new video, keep what scores)

1. **Better source footage is the biggest lever.** Shoot list for events: a phone at the baseline at chest height, 60 fps, 5–10 s rallies close to the camera, every trophy handoff, and the winners' reactions. The net-post camera gave wide, far-away shots that cap the quality.
2. **Speed ramps** on contact (needs 60 fps footage): normal → 40% at impact → normal, with a bass hit.
3. **Ball fire trail** on 1–2 hero hits (track the ball by hand).
4. **Kinetic stat cards**: number roll-ups ("4 DIVISIONS", "2 OF 3 SETS") with a tick sound per digit.
5. **Three hook variants** per ad (different first 2 s). Post-test them and keep the winner's pattern.
6. **Sound bed** from the venue: ball pops, sneaker squeaks, applause, cleaned and layered under the voice-over.
7. **One color LUT across all sources** so the dome footage, photos and stock look like one shoot.
8. **Captions** for silent viewers, as a karaoke line separate from the slam text.

## 4. Pitfalls already paid for
- **Silent voice lines:** fades were timed on the source clock. Use `atrim`/`asetpts`, and the QC checks each line.
- **Frozen end card:** a shot shorter than its slot stalls the transition chain. Fetch a source window ≥ duration + tail; QC catches freezes.
- **Too many Drive downloads at once:** Drive answers 403s. Fetch a few full-quality cuts with `/api/story/clip` and work locally.
- **Parallel renders writing the same file:** keep one writer per output.
- **Frame grabs with `-ss` on joined files** can be a frame or two off. Check exact cuts with `select='eq(n,N)'`.
