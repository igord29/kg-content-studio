---
name: pro-ad-video
description: Make a professional short-form ad or social video (Reels/TikTok/Shorts 9:16 plus 16:9) that meets the house quality floor set by the UnitedSets Thanksgiving all-ages pilot, using the build -> QC gate -> review -> fix loop. Use for any tournament ad, program promo, recap or donor video before it is shown to the user or posted.
---

# Pro ad video: the floor and the loop

## 0. How this client wants to work (read first, every time)

These are standing instructions from the UnitedSets owner (Nov 2026). They override any habit of batching.

- **Pilot first, then the batch.** Send ONE finished video. Make it the best you can, QC'd and reviewed with your own eyes. Wait for approval before building the rest. Never render a whole set from an unapproved concept.
- **Every video is its own idea.** Don't run a set through one template. Shape each video around its specific moment: what happens in it, who is in it, why it's interesting. Vary the hook, the structure, the rhythm, the graphics, the transitions and the payoff from video to video. If two videos in a set could swap footage without anything else changing, one of them needs a new concept.
- **You are the editor.** The client relies on your editing judgment. Make cuts crisp, tight and eventful, and aim every choice at holding attention and earning replays and shares (virality), not at filling a format.
- **Viral social content is not an ad.** Unless asked, engagement videos don't promote an event. No tournament card and no sign-up line; end on a short brand beat that loops.

### Editor's toolbox for one-camera sports footage (pick per moment; never all at once)
- **Cold open on the best moment** (slow motion, glitch-in or freeze), then rewind into the full play.
- **Cut on action:** wide view for the opponent's shot, tight punch-in (with slight shake) on the near player's swing. A whip pan or flash between framings.
- **Speed ramps** around contact (0.3–0.5x with pitched-down sound), and fast-forward through dead time.
- **Freeze-frame** at the peak, with a slam word or sticker. A ⏪ rewind with scanlines into the replay.
- **Live graphics:** rally timer, slow-mo tag, "rate this 1–10" prompt, point-of-view text. Put graphics where the eye already is.
- **Alternative structures:** countdown ("3 shots that…"), split-screen comparison, a "watch the near player's feet" focus guide, a reaction-style caption track, "POV" framing, or a loop where the last frame matches the first.
- **Sound design:** keep the real court sound, add whooshes on transitions, a pop on contact and a boom on the payoff. Duck under the voice.
- **The track points the camera at the player** (person detection), and every crop follows them. Never let a static crop lose the subject.

## 0b. Rally Shorts: the bar is Short 05 ("In or out?", Nov 2026)

The client loved Short 05 and called it the new bar: every new rally Short must be **better** than it. "Clean, the cuts were correct, and the tracking at the end asking if it was in or out made the viewer want to comment." Builder: `tools/rally-short/build_short05.py`. Sound effects: `make_sfx.py`. Thumbnails: `thumbs_short05.py`. Tracking: `track.py` + `paths.py`.

**Keep these qualities. Don't copy the structure** (section 0: every video gets its own concept, hook, question and payoff).

**Game first.** No countdown or "this point lasts 39 seconds" graphics, and no rally timer. The play is the show.

**Cold open (about 2.4 s).** Open on the best moment of the point at real speed, with a question line. Example: Jessica's "Wait. How did maroon get THAT back?!" plus a record scratch. Then a white flash into the serve.

**The point, start to finish, at real speed.**
- A steady wide frame holds both players, with hard cuts to whoever is hitting, about 1.5–2 s per shot.
- The near player gets a tight shot (zoom 1.32, or 1.12 when sliding or running).
- The far player gets a medium shot. When they are at the top edge of the frame, extend it upwards with a mirrored, blurred and darkened copy of the back wall (`headroom()`) so they sit centred. Never blur the real frame.
- No zoom pumping, and never only the near player.

**The finish must be visible.**
- From the last hit, play **one unbroken wide shot** until the ball lands and both players stop. Never cut to a tight framing or away before the result shows.
- Check the outcome frame by frame in the source first. If the footage can't prove who won, don't claim it: make it the question.
- When the winner is known, the winner gets the final highlight.

**The payoff replay (the comment driver).**
1. A slow-motion replay (0.25–0.3×) of the deciding ball, with the **ball circled by a glowing lime ring**. Track the ball frame by frame by reading it off a grid sheet, because it blurs too much for automatic colour detection.
2. A **freeze on the deciding frame** (camera-shutter sound and sub-bass hit), then a push-in until the ball fills the screen, with a big question title (Anton or Montserrat 130 px, lime keyword) at the top.
3. Play on slowly under a "COMMENT YOUR CALL · @UNITEDSETS" pill, and end on a frame that loops into the cold open.

**Voices: two friends watching together, not narration.**
- Brian (play-by-play) and Jessica react to each other ("Did you SEE that slide?!" / "I saw it! I'm still not over it.").
- About 12–15 short lines, each placed on its shot. Shirt colours only.
- Record on Sume eleven-v4. Pad each line (`adelay` 40 ms + `apad` 0.12 s) for the clipped-line QC check.

**Captions: big and word by word.**
- Get word timings with faster-whisper `base.en` on each line, mapped onto the script words.
- Montserrat ExtraBold 92 px, centred, 2–3 words at a time, with the spoken word highlighted and scaled to 112%.
- Brian is lime and Jessica is coral, with a small name label above.
- One position per line, chosen to stay clear of the players, the ball and titles.

**Sound design.**
- Real court sound, ducked under the voices.
- Accents: a scratch on the hook, whooshes on transitions, a riser into the big moment with a sub-bass drop on it, a riser into the last ball, light applause when the point ends, a heartbeat under the slow-mo, a shutter and drop on the freeze, and a pop on the title.

**Logo.** A small bug top-right all the way through (no full-screen end card needed when the replay carries the comment prompt).

**Deliver with every video:**
- the MP4, which must pass QC (Short 05 scored 100);
- a **title, description and tags**, plus a suggested pinned comment;
- **two 1080×1920 thumbnails**. Keep the key content inside the centre 1080×1350 so grid crops still read. Use huge condensed text (Anton) with one lime word, a person mid-action or the circled ball, a red arrow, and one emoji.

**Rotate the payoff across videos:** in or out, "rate it 1–10", "count the shots", "who wins this?", "watch the feet", or a winner's victory replay. Never the same twice in a row.

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
- **Saying who won a point you can't see:** commentary only claims what the footage proves. Celebrate the effort and describe players by shirt colour, with no names and no he/she.
- **Highlight cuts and full recordings are framed differently** (the camera's own auto-framing), so frame matching misses many points. Match by sound (the onset envelope cross-correlated against the highlight's sound) instead, then confirm by eye.
- **Building from a template made ten look-alike videos.** See section 0: pilot one, then give each video its own concept.
- **Wrong stroke calls.** Short 06 said "Big forehand" on a two-handed backhand, and Short 04 called two backhands forehands. The client: "the audience will eat us alive by messing up the basics." Before any commentary line names a stroke (forehand, backhand, volley, slice, overhead, serve):
  1. Settle each player's **handing** from a serve or a clear one-handed forehand. The camera is behind the near player, so the image's right side is the player's right.
  2. Check the actual contact frames, 6–8 frames around the hit. Two hands on the racquet, or racquet taken back on the non-dominant side and finishing over the dominant shoulder, means a backhand.
  3. Write the stroke and frame time into the shot-list comment. If it can't be proven, use a stroke-neutral line ("What a get!", "Big swing!").
- **Too tight, no opponent** (Short 07 v1). A 9:16 crop that follows only the near player hides the other side of the net, and the client said "you don't really see the opponent." When the far player is too small to cut to, use the **wide boxed frame** instead: a square full-height crop showing the whole court and both players, on a blurred fill, with captions in the band below. Save the tight shots for 2–3 big moments. Shorts 04–06, the ones the client called good, all show both players. (The first three new-style Shorts reached 4k views in a few hours with 14 followers.)
- **Cutting away before the result** (the highlight split the rally, or the edit ended on a player's ready position) left the client unsure the point was over. Run the wide shot through the ball dying.
- **Tightening the ending made it harder to read.** A tight crop with a lot of blurred fill hid the context. Show the live result wide; save the tight framing for the replay.
- **Countdown and "this point lasts N seconds" graphics** pulled attention away from the play. The client asked for gameplay first.
- **Thumbnails:** the system PIL in `python3` is broken here, so run thumbnail scripts with `python3.13`. Fetch Anton from the google/fonts GitHub repo.

## 5. Thumbnails: the house standard (client-approved, Nov 2026)

Every video ships with a 9:16 thumbnail (Shorts, Reels and TikTok covers) and a 16:9 one (YouTube and Facebook). There are two types, and only two. Pick by purpose.

**Type 1: engagement Shorts** (rally Shorts, viral clips). Examples: Short 05 "IN OR OUT?", Short 06 "DOWN… THEN THIS".
- One action frame from the video: the deciding ball, the fall, the full stretch.
- Huge condensed text (Anton, 200 px+ on 9:16), 2–4 words, one lime word, black stroke. Make it a question or a reaction.
- One hook element: a red arrow, a circled ball, or one emoji.
- An optional comment pill ("COMMENT 1–10 👇"). Nothing else.

**Type 2: event ads** (tournament promos such as Dec 19). Reference: `demo-output/unitedsets/ads-dec19/thumbnails/UnitedSets-U12-dec19-thumb-*.jpg`.
- **One player, close up, smiling, with the trophy visible.** Pick a player of the division's age: U12 ads use young kids.
- Use a photo **not already used across the marketing**. Check every `specs/*.json` for photos already used, and ask the client about outside use. Fetch full-size originals through `/api/story/frame?fileId=…&t=0&w=1800`, because local copies are 640 px.
- A 3–4 word hook ("FIRST TROPHY?") above the head, plus a **big date block** (SAT · DEC / 19) and the logo. Nothing else: details go in the caption and the video.
- 16:9: the hook and date on a teal panel at the left, the player on the right.

**Rules for both types**
- Text and graphics never cover a face, a player or the trophy.
- Don't put the same player on a second thumbnail in the same campaign.
- No names and no price. Read every thumbnail at phone size (about 400 px wide) before sending.
- Run thumbnail scripts with `python3.13` (the system PIL is broken here).
