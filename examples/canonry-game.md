# The Canonry Game — asset batch

Asset spec for the "Glacial Archive" visual direction: editorial field-journal
illustration, ink and watercolor on warm cream parchment, muted cold palette
with ember used sparingly. Every description below is short on purpose —
Claude reformats each one against the Glacial Archive style anchor before
it hits Flux 2.

<!-- settings -->
preset: glacial-archive
model: flux-2-pro
default_size: 1024x1024
default_aspect: 1:1
<!-- /settings -->

## 1 · Entity sprites

### penguin
file: sprites/penguin.png
type: sprite

A single adult emperor penguin standing upright, seen from a slight 3/4
overhead angle. Dove-grey back, cream belly with faint amber along the
breast. Attentive dark eye. Specimen-card feel.

### settlement
file: sprites/settlement.png
type: sprite

A small cluster of snow-bound penguin shelters — low domed structures of
packed snow and dark stone, a wisp of smoke from a central vent. Warm
light spills from one doorway. Seen from a slight 3/4 overhead angle.

### faction-banner
file: sprites/faction.png
type: sprite

A weathered heraldic banner on a dark pole, dusty rose fabric with a
swallowtail fly, small black emblem, fluttering in polar wind. Small
tears and wear along the edge.

### artifact
file: sprites/artifact.png
type: sprite

An ancient carved bone talisman — diamond-shaped pendant with concentric
inlaid sea-glass patterns, faint rune-like etching. Resting on a flat
surface, seen from slightly above.

### orca
file: sprites/orca.png
type: sprite

A single orca seen from directly above, dorsal fin and back just breaking
the surface of dark polar water. Jet-black body, crisp white eye-patch
and chest, quiet water rippling around it.

### region-cairn
file: sprites/region.png
type: sprite

A small weather-worn stone cairn on a featureless snowfield — three
stacked slate-grey stones with faint lichen, casting a long cold-blue
shadow to one side.

## 2 · Terrain hex tiles

### terrain-wastes
file: terrain/wastes.png
type: hex-tile

Orthographic top-down view of an empty bone-grey snow waste — faint wind
scour patterns, a few dark protruding pebbles, pale cracked surface.
Muted, almost abstract.

### terrain-crags
file: terrain/crags.png
type: hex-tile

Orthographic top-down view of dark basalt crags breaking through thin
snow — jagged rock ridges, deep shadow in the crevasses, pale dusting
of snow caught in pockets.

### terrain-tundra
file: terrain/tundra.png
type: hex-tile

Orthographic top-down view of pale tundra — wind-packed snow broken by
sparse patches of rust-colored lichen and low frozen scrub, faint game
trails winding through.

### terrain-ice
file: terrain/ice.png
type: hex-tile

Orthographic top-down view of a pale glare-ice sheet — faint crackle
pattern, pale blue-white surface, deep slate-blue fracture lines. Looks
cold and slightly translucent.

### terrain-hotsprings
file: terrain/hotsprings.png
type: hex-tile

Orthographic top-down view of a cluster of hot spring pools in snow-rimmed
rock — emerald-green water, faint steam wisps rising, warm sulfur-yellow
and rust mineral deposits ringing each pool. The warmest spot on the map.

### terrain-shelf
file: terrain/shelf.png
type: hex-tile

Orthographic top-down view of a shallow continental shelf — translucent
pale blue water over a visible bed of stone and sand, faint ripples, the
occasional dark kelp patch.

### terrain-reef
file: terrain/reef.png
type: hex-tile

Orthographic top-down view of a cold-water reef — dense kelp-black and
rust tones over deep blue water, skeletal coral structures, pale stone
glimpsed between. Dense and slightly forbidding.

### terrain-ocean
file: terrain/ocean.png
type: hex-tile

Orthographic top-down view of deep polar ocean — abyssal blue-black water
with faint swell patterns catching pale slate highlights. Restrained,
cold, vast.

## 3 · Tableau card faces

### card-penguin
file: cards/card-penguin.png
type: card-face
aspect: 3:4
size: 1024x1536

Upper half: a lone emperor penguin standing on a ridge at dusk, backlit
by a pale aurora-green band in the sky, fine falling snow. Lower half:
a plain warm dark surface reserved for overlaid text, with a faint
ghosted penguin silhouette watermark. Warm cream parchment frame.

### card-settlement
file: cards/card-settlement.png
type: card-face
aspect: 3:4
size: 1024x1536

Upper half: a small settlement at night, warm gilt light spilling from
a domed shelter doorway onto the snow, faint smoke rising, a few stars
suggested. Lower half: plain warm dark surface for overlaid text with
a ghosted settlement watermark. Warm cream parchment frame.

### card-faction
file: cards/card-faction.png
type: card-face
aspect: 3:4
size: 1024x1536

Upper half: a weathered dusty-rose banner planted on a ridge of dark
stone, silhouettes of three distant penguins gathered beneath, cold
overcast sky. Lower half: plain warm dark surface for text with ghosted
banner watermark. Warm cream parchment frame.

### card-artifact
file: cards/card-artifact.png
type: card-face
aspect: 3:4
size: 1024x1536

Upper half: an ancient sea-glass talisman resting on a pedestal of dark
ice, lit from above by a single pale shaft of light. Lower half: plain
warm dark surface for text with ghosted artifact watermark. Warm cream
parchment frame.

### card-orca
file: cards/card-orca.png
type: card-face
aspect: 3:4
size: 1024x1536

Upper half: the shadow of a single orca cruising just beneath a thin
sheet of translucent ice, seen from directly above, dorsal fin cutting
the surface, cold abyssal blue. Lower half: plain warm dark surface for
text with ghosted orca watermark. Warm cream parchment frame.

### card-back
file: cards/card-back.png
type: card-face
aspect: 3:4
size: 1024x1536

A single centered compass rose in dark ink on a warm-cream parchment
field, faint concentric circle patterns radiating outward, aged paper
texture with subtle foxing at the corners. Slate-blue accent on the
compass needle. Museum collection cataloging feel.

## 4 · UI chrome & decoration

### divider-flourish
file: chrome/divider-flourish.png
type: chrome
aspect: 16:9
size: 1536x1024

A long horizontal ink flourish — central small compass-rose motif
flanked by thin hairline rules that fade to nothing at either end.
Chapter-break feel from a 19th-century atlas.

### corner-ornament
file: chrome/corner-ornament.png
type: chrome

A single corner ornament for the top-left corner of a page — elegant
cartographic flourish with small geometric motifs and a delicate
vine-like curl extending along both edges of the corner.

### compass-rose
file: chrome/compass-rose.png
type: chrome

A centered compass rose in the style of an antique nautical chart —
eight-pointed star with elongated N-S axis, fleur-de-lis at north,
finely inked concentric degree rings.

### scale-bar
file: chrome/scale-bar.png
type: chrome
aspect: 16:9
size: 1536x1024

A horizontal cartographic scale bar — alternating filled and empty
segments with small tick marks beneath, labels reading "0  ·  1  ·  2  ·  3
hexes" in small-caps serif.

### texture-parchment
file: chrome/texture-parchment.png
type: background
aspect: 1:1

Seamless aged parchment texture — warm cream base with subtle variations,
faint foxing spots, occasional fiber, hint of horizontal grain. A
background surface — no patterns, no illustration.

### texture-slate
file: chrome/texture-slate.png
type: background
aspect: 1:1

Seamless dark slate stone texture — base color slate, subtle variations
from slightly bluer to slightly greyer, very faint mineral veining. A
quiet background surface.

## 5 · Event-type icons

### icon-lifecycle
file: icons/lifecycle.png
type: icon

A small ink glyph — a circle inscribed with a half-filled triangle,
symbolizing transition between states. Blood-red hot ink, simple enough
to read at 16px.

### icon-threshold
file: icons/threshold.png
type: icon

A small ink glyph — a single horizontal line broken in the middle by an
upward-arrow notch, symbolizing crossing a threshold. Ember ink, urgent.

### icon-creation
file: icons/creation.png
type: icon

A small ink glyph — a seed-like teardrop with two tiny outward-radiating
marks suggesting growth. Aurora cyan-green ink.

### icon-card
file: icons/card.png
type: icon

A small ink glyph — a stylized rectangular card tilted slightly with a
corner fold suggested by a single diagonal line. Warm gilt ink.

### icon-notice
file: icons/notice.png
type: icon

A small ink glyph — simple open circle with a centered dot, the
universal "mark, notice" sigil. Parchment-tone ink.

## 6 · Attribute icons

### attr-food
file: icons/attr-food.png
type: icon

A simple fish silhouette arched slightly, single line, no scales — pure
iconography. Dark ink.

### attr-wealth
file: icons/attr-wealth.png
type: icon

Three stacked coins viewed from the edge — three narrow horizontal
ellipses, faint gilt wash on the topmost coin only.

### attr-population
file: icons/attr-population.png
type: icon

Three overlapping penguin silhouettes — a huddle reduced to essential
curves, no faces, no detail.

### attr-warmth
file: icons/attr-warmth.png
type: icon

A simple flame — three symmetric tongues, ember-orange wash inside a
dark ink outline.

### attr-echo
file: icons/attr-echo.png
type: icon

Four concentric expanding wave-rings radiating outward from a center
dot — symbolic of social resonance.

### attr-dominion
file: icons/attr-dominion.png
type: icon

A simple crown-like form — three rounded points over a horizontal band,
reduced to essential silhouette.

### attr-power
file: icons/attr-power.png
type: icon

An angular lightning-like mark — a single bold zig-zag stroke, no
gradient.

### attr-holding
file: icons/attr-holding.png
type: icon

A hand grasping a small stone, seen in profile silhouette, reduced to
essential curves.

### attr-provisions
file: icons/attr-provisions.png
type: icon

A simple sack or bundle tied at the top with a single diagonal line for
the tie.

## 7 · Atmospheric art

### title-ice-remembers
file: backgrounds/title.png
type: background
aspect: 16:9
size: 1536x1024

Wide cinematic landscape: a vast polar ridgeline at dusk, a lone penguin
silhouette standing on the foreground crest, pale aurora-green band
stretching across a cold slate sky, tiny settlements suggested by faint
warm gilt lights in the far distance. Reverent, quiet, painterly.

### tableau-backdrop
file: backgrounds/tableau.png
type: background
aspect: 16:9
size: 1536x1024

A subtle textured dark backdrop for behind UI — a ghostly illustrated
map of the simulation world in near-monochrome dark slate and very faint
gilt, with hex grid lines barely visible, compass rose in one corner.
Quiet and non-distracting.

### aurora-band
file: backgrounds/aurora.png
type: background
aspect: 16:9
size: 1536x1024

A wide horizontal band of pale aurora cyan-green with faint purple
undertones, soft-edged and ribbon-like, painterly with suggested wisps
and fade-outs. Intended as an overlay accent.

## 8 · Playback control icons

### ctrl-pause
file: chrome/ctrl-pause.png
type: icon

Two parallel vertical bars with soft rounded ends in dark ink with the
faintest brush-thickness variation.

### ctrl-step
file: chrome/ctrl-step.png
type: icon

A single right-pointing arrowhead followed by a thin vertical bar to
its right, in dark ink. "Advance one frame" feel.

### ctrl-reset
file: chrome/ctrl-reset.png
type: icon

A counterclockwise circular arrow with an arrowhead pointing to the
upper-left, in dark ink with faint brush variation.
