# Aetheria — Echoes of the Dawn

A stylised open-world action-adventure that runs in the browser (WebGL2, three.js r170), in the spirit of
*Breath of the Wild* / *Genshin Impact*: a 4 km² procedurally generated island with meadows, forests, a snow
peak, lakes, rivers and a coast; climbing, gliding, swimming, sword combat, shrines, a village, a boss and a
day/night cycle.

## Run

Play it at https://yfde.github.io/aetheria/ (Chrome, a discrete GPU recommended).

To run a copy yourself there is no build step; any static file server works:

    python3 -m http.server 8137      # then open http://127.0.0.1:8137/ in Chrome

## Controls

| Key | Action |
|---|---|
| WASD / mouse | move / look (click the view to capture the mouse) |
| Space | jump · press again in the air to glide · leap while climbing |
| Shift | sprint / fast swim |
| Left mouse | sword combo |
| Right mouse | raise shield |
| C or Ctrl | dodge roll · let go of a wall |
| Q | Gale Burst: knocks enemies up and leaves an updraft to glide on |
| E | interact (talk, chests, waypoints, altars, campfires) |
| R | eat an apple (+1 heart) |
| M | map and fast travel between attuned waypoints |
| H | hide the HUD (photo mode) · Esc: pause / settings |

Walk into any cliff or wall to climb it. The green ring is stamina.

## Layout

    index.html            entry page (import map, no bundler)
    src/main.js           boot, game state, main loop
    src/core/             renderer pipeline (CSM shadows, HDR, bloom, god rays, FXAA), input, audio, noise textures
    src/shaders/          shared GLSL chunks (lighting, fog, shadows, world maps)
    src/world/            world generation (worker), terrain clipmap, grass, trees, water, sky + clouds, buildings, collision
    src/game/             player, camera, enemies, wildlife, props, story, VFX
    src/ui/               HUD and menus
    assets/models/vrm     anime-style avatars (hero + villagers)
    assets/models/ual     Universal Animation Library (33 clips)
    assets/models/kaykit  extra animation clips (chibi rig)
    assets/models/village modular medieval building kit + textures (houses, tower, shrines, camps, ruins)
    assets/models/creatures animated animals, orc and demon raiders, treasure chests
    vendor/               three.js and three-mesh-bvh
    tools/                dev helpers (headless screenshots, scripted play, GLB stripper) – kept out of the published repo

Developer URL switches: `?play=1` (skip the title), `&pos=x,z`, `&tod=hours`, `&stage=n`, `&q=0..3` (quality), `&fly=1` (free camera), `&hero=knight` (the original chibi knight instead of the anime avatar), `&rain=1` (force a rain front).

Regression scripts (headless Chrome, run from this folder; they live in the local `tools/` folder, which is not published): `uv run -q --with playwright tools/t_intro.py tools/shots` (title → new game, then real keyboard and mouse input) and `tools/t_quest.py tools/shots` (the whole quest, save and continue). `tools/t_first.py tools/shots` walks through the first minutes of a new game, `tools/t_map.py tools/shots` checks the map and fast travel, `tools/t_shrine.py tools/shots` walks up each shrine's steps with real keyboard input, `tools/t_combo.py tools/shots` drives the sword combo, dash slash and guard with real mouse input, `tools/t_fight.py tools/shots` mashes through a raider camp and climbs Skywatch Tower, `tools/t_beasts.py tools/shots` checks that deer bolt and that wolves and camp raiders fight and die through the normal damage path, `tools/t_wild.py tools/shots` counts and photographs the herds, `tools/t_enemy.py tools/shots [hour]` lines up the four masked shades for a look, and `tools/t_anim.py OUT.png Clip1,Clip2` (add `--with pillow`) renders a contact sheet of animation clips on the hero.

## Credits

- Hero and villagers: VRoid sample avatars by pixiv — *Vita* and *Victoria Rubin* (CC0), *AvatarSample A/B/C* (free use incl. commercial and modification), shrunk with `tools/shrink_vrm.py`. The hero's cape, sword and the villagers' cloaks and hats are procedural.
- Animation: Quaternius' *Universal Animation Library* 1 and 2 (CC0, human proportions) drive locomotion, jumping, rolling, swimming, the three-hit sword combo with its recoveries, the dash slash, the guard, the ledge climb-up, opening chests, eating, waking up, hits and deaths, plus the villagers' idle work; a few clips (light slashes, guard, gestures) come from KayKit's *Adventurers* pack by Kay Lousberg (CC0). Both are re-targeted onto the avatars at load time (`src/game/vrmchar.js`).
- Buildings: Quaternius' *Medieval Village MegaKit* (CC0), merged and shrunk with `tools/build_village_kit.py` and assembled in `src/world/villagekit.js` into Hearthvale's houses, Skywatch Tower, the three trial shrines, the raider camps and the ruined cottages.
- Wildlife, raiders and chests: Quaternius' *Ultimate Animated Animal Pack*, *Ultimate Monsters* and *Ultimate RPG Pack* (all CC0; see `assets/models/creatures/LICENSE.txt`). Deer, stags, foxes and wild horses roam and bolt when approached, cattle and a dog live in Hearthvale, wolf packs hunt in the woods and the snow, and orcs with a demon chief hold the camps (`src/game/creatures.js`, `src/game/enemies.js`).
- Shrine guards: the shades are one sample avatar drawn as living shadow; their bone masks, horns, manes and pauldrons are built in code (`shadeGear` in `src/game/vrmchar.js`).
- Enemies: slimes and the Colossus are procedural; the Hollow (shadow swordsmen) are untextured clones of *AvatarSample C*.
- three.js (MIT), three-mesh-bvh (MIT), @pixiv/three-vrm (MIT).
- Everything else (terrain, vegetation, buildings, water, sky, effects, sound, music) is generated procedurally at run time.

## Status

Paused on 2026-11-13 at the owner's request; to be resumed later. The game plays from title to credits, but it does not
yet look like its references. Known gaps, in rough order of value:

- wall climbing and gliding still use code-driven poses (no free authored clips found; the ledge climb-up is authored)
- the hero and villagers are stock sample avatars
- the shrine-guard shades and the Sanctum boss are code-built
- three art styles are mixed (anime avatars, low-poly animals, cartoon raiders)
- a few village props are still crude (market stall goods, pots)
- nobody has listened to the audio or judged the feel of the controls by hand

