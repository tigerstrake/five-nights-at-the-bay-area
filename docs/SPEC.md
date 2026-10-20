# FIVE NIGHTS AT THE BAY AREA
## Complete Game Implementation Specification

### 1. Objective

Build a polished, browser-based, asymmetric multiplayer survival-horror game inspired by Five Nights at Freddy's, set across a real network of publicly accessible Bay Area traffic cameras.

One player controls a supernatural monster through strategic commands. Other players cooperate to defend a headquarters from the monster.

The game combines:
- Real Bay Area CCTV feeds and snapshots.
- An interactive geographical and tactical map.
- A human-directed, AI-controlled monster.
- Cooperative headquarters defense.
- Network-based navigation and surveillance.
- Psychological horror, camera interference, and atmospheric effects.
- Online and local multiplayer.
- 5 to 10-minute matches.

**Visual quality, game feel, reliability, and genuine strategic depth are priorities.**

The implementation should be fully playable, not a static mockup.

### 2. Technology

Use the following default architecture unless a better technical choice is justified:

- Frontend: React, TypeScript, Vite.
- Styling: Tailwind CSS and custom animations.
- Map: MapLibre GL JS with suitable map tiles.
- Backend: Node.js, TypeScript.
- Networking: Socket.IO with WebSocket transport.
- Game simulation: Authoritative server-side state machine.
- Persistence: In-memory state for active matches; optional SQLite for game history.
- Camera integration: Dedicated backend camera-data adapter.
- Rendering: Canvas/WebGL for monster effects and visual overlays.
- Audio: Web Audio API and locally hosted sound assets.
- Testing: Vitest and Playwright.

The game must run locally with straightforward setup instructions and also support deployment for internet multiplayer.

Separate the game simulation from UI rendering and external camera integrations.

### 3. Multiplayer

Support:
- One monster player.
- A flexible number of cooperating defender players.
- Automatic difficulty scaling based on defender count.
- Room creation and join codes.
- Player names and a lobby.
- Headquarters selection.
- Ready states and synchronized countdowns.
- Reconnection after temporary disconnection.
- Restarting matches without reloading the application.
- Spectator support if practical.

The server is authoritative. Clients submit actions; the server validates them and broadcasts state updates.

Prevent clients from accessing secret information belonging to the opposing team.

### 4. Real Bay Area Camera Network

Use approximately 20 to 40 actual publicly available Bay Area traffic cameras.

Primary source:
https://cwwp2.dot.ca.gov/

Camera documentation:
https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm

Geographic camera dataset:
https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0

Prioritize Caltrans District 4.

Retrieve and normalize:
- Camera identifier.
- Name and location.
- Latitude and longitude.
- Image URL when available.
- Video stream URL when available.
- Camera availability and last update.
- Supported media type.

Prefer working live video, with periodically refreshed snapshots as fallback.

Do not assume that every published stream can be embedded in a browser. Check technical access and provider usage conditions. Do not circumvent restrictions.

Build a curated camera selection that supports interesting routes around the Bay Area, especially bridges and highway connections.

When footage is inaccessible, show a clear offline state or use explicitly labeled simulation footage. Never represent simulated footage as genuine live imagery.

### 5. Map System

Provide two switchable map modes.

**Geographical mode**
- Real Bay Area map.
- Accurate camera locations.
- Roads and bridge connections.
- Selectable headquarters.
- Camera-status indicators.
- Zooming, panning, and camera inspection.

**Tactical mode**
- Dark stylized map.
- Camera nodes and graph connections.
- Defended zones.
- Traps and surveillance coverage.
- Monster sightings and last-known locations.
- Threat indicators.

Construct a connected gameplay graph from the curated camera locations.

Edges should represent geographically plausible movement, not arbitrary teleportation.

Use actual geography where practical but prioritize balanced gameplay.

### 6. Headquarters

Before each match, defenders select one of several predefined headquarters in the Bay Area.

Suggested headquarters:
- Palo Alto / Stanford area.
- Downtown San Francisco.
- Oakland.
- San Jose.

Each headquarters has:
- A distinct position on the gameplay map.
- Several possible approaches.
- A configurable security system.
- Doors, sensors, and defensive devices.
- A breach state.

Headquarters are fictional game locations. They do not control actual infrastructure.

The monster wins by successfully breaching headquarters.

### 7. Defender Gameplay

Defenders cooperatively operate a virtual surveillance and security control room.

All defenders have access to the same systems. They may divide responsibilities voluntarily.

The control room must contain:
- Multiple simultaneous CCTV panels.
- One enlarged, selectable camera feed.
- Interactive tactical/geographical map.
- Headquarters security controls.
- Shared power indicator.
- Threat status.
- Match timer.
- Team notifications and event history.

**Defensive mechanics**

Implement:

1. Security doors: temporarily prevent entry, consuming power.
2. Motion sensors: report suspicious movement around nearby map nodes.
3. Surveillance scanning: helps identify the monster but consumes resources.
4. Remote traps: immobilize the monster briefly when triggered.
5. Camera repairs: restore game-disabled camera feeds after a repair delay.
6. Alarms and decoys: manipulate the monster's strategy.
7. Power management: force tradeoffs between monitoring, defenses, and repairs.

Remote traps, doors, and roadblocks are purely fictional gameplay mechanisms.

Defenders should never have access to controls for actual public cameras or infrastructure.

### 8. Monster Gameplay

The monster is controlled by a human player who issues high-level strategic commands.

Provide an interactive tactical interface showing:
- Current monster position.
- Available movement routes.
- Possible attack paths.
- Abilities and cooldowns.
- Known defender surveillance coverage.
- Targets and objectives.

**Monster commands**

- HUNT: Find and approach a vulnerable target.
- HIDE: Reduce visibility and avoid detection.
- FLANK: Seek less defended routes.
- SABOTAGE: Disable a selected camera or fictional sensor.
- DECOY: Create a misleading sighting.
- ATTACK: Attempt to breach a defense or advance toward headquarters.
- RETREAT: Escape a trap or contested area.

Commands are converted into actions by the AI movement and decision system.

The human remains strategically in control.

### 9. Monster AI

Implement a responsive tactical agent that:
- Uses pathfinding on the camera-node graph.
- Chooses routes based on player commands.
- Avoids defended areas when appropriate.
- Reacts to traps and surveillance.
- Exploits temporarily disabled cameras.
- Adjusts aggression as the match progresses.
- Occasionally changes tactics to remain unpredictable.

Use A* or another suitable graph-search algorithm, supplemented by behavior trees, utility scoring, or a finite-state machine.

A live LLM is not necessary for moment-to-moment decisions. Prioritize low latency, deterministic state synchronization, and believable behavior.

The AI should not give the monster information that its human player would not legitimately possess.

### 10. Monster Appearance

The monster must appear visually connected to the surveillance system.

Use a gradual visibility system:

**Far from headquarters**
- Occasional silhouettes.
- Unusual shadows.
- Subtle video distortion.
- Brief, ambiguous appearances.

**Approaching headquarters**
- More frequent visual manifestations.
- Camera glitches.
- Audio interference.
- Stronger monster silhouettes.
- Increased threat indicators.

**At headquarters**
- Clear monster appearances.
- Heavy interference.
- Intense audio and visual effects.
- A cinematic breach sequence.

For performance, use pre-rendered 2D/3D assets, shaders, and overlays rather than requiring real-time generative video.

All monster imagery is fictional and composited within the game.

Support configurable placement regions for each camera, allowing the creature to appear at plausible positions within its image.

Do not assume a camera can depict the monster merely because the monster occupies a nearby geographic node. The appearance system should respect game visibility rules.

### 11. Interference and Sabotage

Support:
- Random fictional camera failures.
- Monster-triggered sabotage.
- Static and signal loss.
- Temporary feed blackouts.
- False sightings.
- Defender repairs.
- Recovery indicators.

Distinguish actual source-camera unavailability from fictional in-game sabotage within the code.

The camera adapter should continue operating independently of fictional game outages.

### 12. Match Structure

Default match duration: 8 minutes.

Allow configurable durations from 5 to 10 minutes.

A match has four phases:

**Phase 1: Preparation**
Defenders select headquarters and establish initial defenses. The monster chooses an initial strategy.

**Phase 2: Infiltration**
The monster moves through outer camera nodes, hiding and testing surveillance.

**Phase 3: Escalation**
The monster becomes more aggressive. Power constraints, traps, and sabotage become increasingly important.

**Phase 4: Final Assault**
The monster approaches headquarters. Defenders must commit their remaining resources to containment.

**Victory conditions**

Monster wins by breaching headquarters before time expires.

Defenders win by:
- Surviving until the match timer expires, or
- Successfully trapping and containing the monster for a defined capture period.

A temporary trap alone does not constitute victory.

All win conditions must be evaluated by the server.

### 13. Balance

Use configurable gameplay parameters rather than scattering magic numbers throughout the code.

Initial balancing targets:
- Match duration: 480 seconds.
- Defender preparation: 20 seconds.
- Monster ability cooldowns: 15–60 seconds depending on ability.
- Temporary trap duration: 8 seconds.
- Capture requires uninterrupted containment for 15 seconds.
- Camera repair: 10 seconds.
- Power consumption varies by active defense.
- Monster speed, detection risk, and defensive resource availability scale with defender count.

These are initial tuning defaults, not fixed requirements.

Both teams should have meaningful counterplay.

The monster must not be able to instantly bypass every defense, while defenders must not be able to permanently lock down all routes.

### 14. Visual Design

Create a cinematic, premium-quality horror interface.

References:
- Five Nights at Freddy's surveillance atmosphere.
- Real-world CCTV control rooms.
- Tactical security systems.
- Psychological horror games.

Visual direction:
- Almost-black backgrounds.
- Muted gray panels.
- Restrained red warning accents.
- Green or cyan system-status indicators.
- Subtle noise and CRT effects.
- Crisp typography.
- Smooth transitions.
- Detailed camera overlays.
- Realistic status indicators.
- Minimal unnecessary decoration.

Prioritize atmosphere and readability over excessive visual noise.

The two teams should have distinct interfaces.

**Defender UI**

A dense multi-monitor control room with surveillance feeds, tactical map, security controls, and headquarters status.

**Monster UI**

A dark strategic command interface with routes, abilities, targets, risk indicators, and AI-command feedback.

Include high-quality lobby, loading, victory, defeat, and post-match screens.

### 15. Sound Design

Add:
- Low atmospheric drones.
- Camera-switch sounds.
- Static and interference.
- Distant monster noises.
- Warning alarms.
- Defense activation sounds.
- Escalating tension near headquarters.
- Cinematic victory and defeat audio.

Audio must be optional and support a master volume control.

Avoid playing audio until the user has interacted with the page, consistent with browser restrictions.

### 16. Camera Reliability and Fallbacks

The external camera system must not determine whether the game is playable.

Implement three modes:

1. Live camera mode: use actual supported live streams.
2. Snapshot mode: refresh publicly available still images.
3. Simulation mode: use bundled or otherwise permitted sample imagery.

The game should automatically degrade gracefully when cameras fail.

A camera temporarily unavailable in real life must not break the game simulation.

Provide a visible distinction between live and simulated camera imagery.

### 17. Development Workflow

Implement in coherent milestones:

**Milestone A: Functional foundation**
- Running frontend and backend.
- Multiplayer rooms.
- Defender and monster interfaces.
- Connected camera-node graph.
- Server-authoritative movement.
- Functional victory and defeat conditions.

**Milestone B: Real camera integration**
- Caltrans adapter.
- Camera discovery.
- Curated camera selection.
- Snapshot and stream rendering.
- Unavailable-camera handling.
- Real geographical map.

**Milestone C: Strategic gameplay**
- AI monster commands.
- Pathfinding.
- Doors and power.
- Surveillance tools.
- Sabotage.
- Traps and repairs.
- Balance configuration.

**Milestone D: Atmosphere and polish**
- Monster overlays.
- Camera distortions.
- Advanced animations.
- Sound effects.
- Cinematic outcomes.
- Improved visual design.

**Milestone E: Quality assurance**
- Multiplayer synchronization.
- Reconnection.
- Camera failure recovery.
- Responsive UI.
- Game-balance testing.
- Automated tests.
- Deployment instructions.

Complete each milestone before introducing unnecessary complexity in the next.

### 18. Quality Requirements

The following scenarios must work:

- Two players can join the same match using separate browsers.
- One player is assigned the monster role.
- Other players join as defenders.
- Defenders select headquarters.
- The monster issues a high-level command.
- The AI moves it through connected nodes.
- Defenders see sightings but not the monster's exact hidden position.
- The monster can sabotage a fictional camera.
- Defenders can repair it.
- Defenders can activate a trap.
- Power consumption and cooldowns behave correctly.
- Both sides can win under their respective conditions.
- All participants receive synchronized game results.
- The game remains functional if external camera sources become unavailable.
- A complete match can be played using simulation mode without external API access.

Write automated tests for critical game-state transitions, information visibility, pathfinding, and victory conditions.

### 19. Deliverables

Create a complete project repository containing:

- Full frontend source.
- Full backend source.
- Camera API integration.
- Multiplayer game engine.
- Monster AI.
- Interactive maps.
- Game assets and audio where licensing permits.
- Tests.
- Environment variable template.
- README covering installation, development, and deployment.
- Documentation of architecture and core game mechanics.

Do not use placeholder buttons that appear interactive but do nothing.

Do not fabricate real-time camera feeds, API responses, or successful integrations.

If a feature depends on an unavailable external service, implement a working alternative and document the limitation.

### 20. Instructions to the implementer

Make reasonable engineering and game-design decisions independently instead of repeatedly requesting clarification.

Inspect available tools, libraries, and APIs before choosing an implementation.

Start by establishing a functional game loop and multiplayer experience, then integrate real camera data and polish the presentation.

Create a cohesive, professional game rather than a collection of disconnected demonstrations.

Prioritize reliable mechanics, strong atmosphere, responsive interaction, and maintainable code.

Run the application and tests, fix discovered issues, and document anything that remains incomplete.

The target is a genuinely playable asymmetric multiplayer horror game grounded in the real geography and publicly accessible camera network of the San Francisco Bay Area.
