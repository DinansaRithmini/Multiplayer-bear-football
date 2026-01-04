/*
 * Client script for Goal Ball game.
 *
 * Connects to the server via WebSockets, receives authoritative state,
 * and renders the arena using Three.js. Players move their avatars with
 * keyboard or touch controls, pick up balls hidden on the map and score
 * goals at their end of the field. The client sends only input commands
 * to the server; all movement and scoring logic is handled on the
 * server.
 */

(function () {
  // Connection & state
  let socket;
  let playerId = null;
  let team = null;
  let gameState = { players: [], balls: [] };
  const playerMeshes = new Map(); // id -> mesh
  const ballMeshes = new Map(); // id -> mesh

  // Three.js scene components
  let scene, camera, renderer;
  const worldWidth = 800;
  const worldHeight = 500;
  let bushes = [];
  let goals = {};

  // New: Bear model (loaded once, cloned per player)
  let bearModel = null;
  let bearAnimations = [];
  const playerMixers = new Map(); // id -> AnimationMixer
  const playerAnimationStates = new Map(); // id -> { currentAction, isMoving }
  const playerRotationData = new Map(); // id -> { targetRotation, currentRotation }
  const playerPreviousPositions = new Map(); // id -> { x, y } - track previous positions

  // Football model (loaded once, cloned per ball)
  let footballModel = null;
  // New: Grass model (loaded once, cloned per bush)
  let grassModel = null;

  const clock = new THREE.Clock();

  // Movement and rotation constants
  const ROTATION_SPEED = 3.0; // radians per second
  let currentDirection = { x: 0, y: 0 }; // Current input direction (for immediate response)

  /** Initialise WebSocket connection */
  function initSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}`);
    socket.addEventListener('open', () => {
      console.log('Connected to server');
    });
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init') {
        playerId = msg.id;
        team = msg.team;
        console.log('You are player', playerId, 'on team', team);
      } else if (msg.type === 'state') {
        gameState.players = msg.players;
        gameState.balls = msg.balls;
      }
    });
    socket.addEventListener('close', () => {
      console.warn('Disconnected from server');
    });
  }

  /** Set up the Three.js scene, camera, lights, ground, goals and bushes */
  function initScene() {
    scene = new THREE.Scene();

    // Ambient light for base illumination
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);

    // Main directional light (sun)
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(100, 200, 100);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.camera.left = -400;
    dirLight.shadow.camera.right = 400;
    dirLight.shadow.camera.top = 400;
    dirLight.shadow.camera.bottom = -400;
    scene.add(dirLight);

    // Add a second directional light from the opposite direction for better illumination
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-100, 100, -100);
    scene.add(dirLight2);

    // Camera
    camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      1,
      2000,
    );
    camera.position.set(0, 600, 400);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Enable better texture and material rendering
    // Use outputColorSpace for newer Three.js versions, fallback to outputEncoding
    if (renderer.outputColorSpace !== undefined) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    document.getElementById('gameContainer').appendChild(renderer.domElement);

    // Load 3D field model
    const fieldLoader = new THREE.GLTFLoader();
    fieldLoader.load('professional_soccer_field.glb', (gltf) => {
      const fieldModel = gltf.scene;

      // Scale the field model to match our world dimensions and make it larger
      fieldModel.scale.set(20, 20, 20); // Increased size significantly

      // Position the field more to the left
      fieldModel.position.set(0, 0, 0); // Moved 200 units to the left

      // Rotate the field 90 degrees around the Y axis
      fieldModel.rotation.y = Math.PI / 2; // 90 degrees rotation

      // Use only the original GLB model textures - no modifications
      console.log('Soccer field model loaded, preserving original materials and textures...');

      fieldModel.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          console.log('Mesh found:', child.name);
          console.log('Original material:', child.material);

          if (child.material) {
            // Handle array of materials
            if (Array.isArray(child.material)) {
              child.material.forEach((mat, index) => {
                console.log(`Material ${index}:`, mat);
                console.log(`Material ${index} original color:`, mat.color.getHexString());

                if (mat.map) {
                  console.log(`Material ${index} has original texture:`, mat.map);
                  // Only fix encoding for proper display
                  if (mat.map.colorSpace !== undefined) {
                    mat.map.colorSpace = THREE.SRGBColorSpace;
                  } else {
                    mat.map.encoding = THREE.sRGBEncoding;
                  }
                  mat.map.needsUpdate = true;
                } else {
                  console.log(`Material ${index} uses original color (no texture)`);
                }

                // Don't modify colors or textures - just update for rendering
                mat.needsUpdate = true;
              });
            } else {
              // Handle single material
              console.log('Single material original color:', child.material.color.getHexString());

              if (child.material.map) {
                console.log('Material has original texture:', child.material.map);
                // Only fix encoding for proper display
                if (child.material.map.colorSpace !== undefined) {
                  child.material.map.colorSpace = THREE.SRGBColorSpace;
                } else {
                  child.material.map.encoding = THREE.sRGBEncoding;
                }
                child.material.map.needsUpdate = true;
              } else {
                console.log('Material uses original color (no texture)');
              }

              // Don't modify colors or textures - just update for rendering
              child.material.needsUpdate = true;
            }
          }
        }
      });

      scene.add(fieldModel);
      console.log('3D field model loaded successfully');
    }, undefined, (error) => {
      console.warn('Failed to load 3D field model, using fallback plane:', error);

      // Fallback: Create simple ground plane if 3D model fails to load
      const groundGeom = new THREE.PlaneGeometry(worldWidth, worldHeight);
      const groundMat = new THREE.MeshLambertMaterial({ color: 0x0a0832 });
      const ground = new THREE.Mesh(groundGeom, groundMat);
      ground.rotation.x = -Math.PI / 2;
      scene.add(ground);
    });

    // Goals: create simple goal markers (your 3D field might already have goals)
    // You can comment these out if your field model includes goals
    const goalGeom = new THREE.BoxGeometry(20, 2, 60);
    const leftMat = new THREE.MeshLambertMaterial({ color: 0x002c8b, transparent: true, opacity: 0.7 });
    const rightMat = new THREE.MeshLambertMaterial({ color: 0x8b0015, transparent: true, opacity: 0.7 });
    const leftGoal = new THREE.Mesh(goalGeom, leftMat);
    leftGoal.position.set(-worldWidth / 2 + 10, 1, 0);
    scene.add(leftGoal);
    const rightGoal = new THREE.Mesh(goalGeom, rightMat);
    rightGoal.position.set(worldWidth / 2 - 10, 1, 0);
    scene.add(rightGoal);
    goals = { left: leftGoal, right: rightGoal };

    // Generate bushes: random boxes around the field
    const bushGeom = new THREE.BoxGeometry(20, 10, 20);
    const bushMat = new THREE.MeshLambertMaterial({ color: 0x0f8130 });
    const numBushes = 10;
    for (let i = 0; i < numBushes; i++) {
      const b = new THREE.Mesh(bushGeom, bushMat);
      // Avoid placing bushes too close to goals
      let bx, by;
      do {
        bx = (Math.random() - 0.5) * (worldWidth - 200);
        by = (Math.random() - 0.5) * (worldHeight - 100);
      } while (Math.abs(bx) > worldWidth / 2 - 60 && Math.abs(by) < 80);
      b.position.set(bx, 5, by);
      scene.add(b);
      bushes.push(b);
    }

    // New: Load the bear model asynchronously using the global THREE.GLTFLoader
    const loader = new THREE.GLTFLoader();
    loader.load('angela_running.glb', (gltf) => {
      bearModel = gltf.scene;
      bearAnimations = gltf.animations;
      // Adjust scale to be smaller (~16 units tall; test and tweak)
      bearModel.scale.set(50, 50, 50);
      
      console.log('✅ Bear model loaded with', bearAnimations.length, 'animations');
      bearAnimations.forEach((clip, index) => {
        console.log(`  Animation ${index}: ${clip.name}, duration: ${clip.duration}s, tracks: ${clip.tracks.length}`);
      });
      
      // Find all meshes in the model
      let hasSkeleton = false;
      let meshCount = 0;
      bearModel.traverse((child) => {
        if (child.isMesh || child.type === 'Mesh' || child.type === 'SkinnedMesh') {
          meshCount++;
          console.log(`  Mesh ${meshCount}:`, child.name, 'type:', child.type);
          console.log('    has skeleton:', !!child.skeleton);
          console.log('    has bindMatrix:', !!child.bindMatrix);
          
          // Check geometry for skinning attributes
          const geom = child.geometry;
          if (geom && geom.attributes) {
            console.log('    skinIndex:', !!geom.attributes.skinIndex);
            console.log('    skinWeight:', !!geom.attributes.skinWeight);
          }
          
          if (child.type === 'SkinnedMesh' || child.skeleton) {
            console.log('    ✅ This is a SkinnedMesh with', child.skeleton ? child.skeleton.bones.length : 0, 'bones');
            hasSkeleton = true;
          }
        }
      });
      
      console.log(`  Found ${meshCount} meshes total, hasSkeleton: ${hasSkeleton}`);
      
      if (!hasSkeleton && meshCount > 0) {
        console.warn('  ⚠️ Meshes found but no skeleton detected - animation may not work properly');
        console.warn('  This could be a model export issue. Try re-exporting with "Apply Modifiers" or skeleton enabled.');
      }
    }, undefined, (error) => {
      console.error('Error loading bear model:', error);
    });

    // Load the football model
    loader.load('football.glb', (gltf) => {
      footballModel = gltf.scene;
      // Adjust scale to be appropriate for the game (football should be smaller than bear)
      footballModel.scale.set(0.3, 0.3, 0.3);
      console.log('Football model loaded successfully');
    }, undefined, (error) => {
      console.error('Error loading football model:', error);
    });

    // Resize handler
    window.addEventListener('resize', onWindowResize, false);
  }

  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Input handling: keyboard and touch controls */
  function initInput() {
    // Keyboard
    document.addEventListener('keydown', (e) => {
      handleKey(e.key, true);
    });
    document.addEventListener('keyup', (e) => {
      handleKey(e.key, false);
    });
    // Touch controls for mobile
    const upBtn = document.getElementById('upBtn');
    const downBtn = document.getElementById('downBtn');
    const leftBtn = document.getElementById('leftBtn');
    const rightBtn = document.getElementById('rightBtn');
    const controls = document.getElementById('controls');
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouch) {
      controls.style.display = 'grid';
    }
    function bindButton(btn, dx, dy) {
      let active = false;
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        active = true;
        sendDirection(dx, dy);
      });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        active = false;
        sendDirection(0, 0);
      });
    }
    bindButton(upBtn, 0, -1);
    bindButton(downBtn, 0, 1);
    bindButton(leftBtn, -1, 0);
    bindButton(rightBtn, 1, 0);
  }

  let keyState = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false, w: false, a: false, s: false, d: false };
  function handleKey(key, down) {
    if (keyState.hasOwnProperty(key)) {
      keyState[key] = down;
      computeDirection();
    }
  }
  // Compute direction vector from keyState and send to server
  function computeDirection() {
    let dx = 0;
    let dy = 0;
    if (keyState.ArrowUp || keyState.w) dy -= 1;
    if (keyState.ArrowDown || keyState.s) dy += 1;
    if (keyState.ArrowLeft || keyState.a) dx -= 1;
    if (keyState.ArrowRight || keyState.d) dx += 1;

    // Update current direction for rotation calculations
    currentDirection.x = dx;
    currentDirection.y = dy;

    sendDirection(dx, dy);
  }
  function sendDirection(x, y) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', x, y }));
    }
  }

  /** Update scoreboard overlay based on gameState */
  function updateScoreboard() {
    // Compute team scores
    let leftScore = 0;
    let rightScore = 0;
    for (const p of gameState.players) {
      if (p.team === 'left') leftScore += p.score;
      else if (p.team === 'right') rightScore += p.score;
    }
    // Update bar widths and text
    const leftElem = document.getElementById('leftTeam');
    const rightElem = document.getElementById('rightTeam');
    const leftFill = leftElem.querySelector('.fill');
    const rightFill = rightElem.querySelector('.fill');
    const leftScoreValue = leftElem.querySelector('.scoreValue');
    const rightScoreValue = rightElem.querySelector('.scoreValue');
    leftFill.style.width = `${Math.min(leftScore / 3, 1) * 100}%`;
    rightFill.style.width = `${Math.min(rightScore / 3, 1) * 100}%`;
    leftScoreValue.textContent = `${leftScore} / 3`;
    rightScoreValue.textContent = `${rightScore} / 3`;
  }

  /** Calculate target rotation based on movement direction and team */
  function calculateTargetRotation(dx, dy, playerTeam) {
    if (dx === 0 && dy === 0) return null; // No movement, no rotation change

    // In Three.js top-view: X = left/right, Z = up/down on screen
    // dx: -1 = left, 1 = right
    // dy: -1 = up, 1 = down
    // Position mapping: mesh.position.set(p.x, 12, p.y) means server y -> Three.js Z
    
    // Math.atan2(z, x) gives us the rotation around Y-axis
    // Negate dy to fix inverted up/down facing direction
    let targetRotation = Math.atan2(-dy, dx) + Math.PI / 2;

    return targetRotation;
  }

  /** Smoothly interpolate rotation */
  function interpolateRotation(current, target, deltaTime) {
    if (target === null) return current;

    let difference = target - current;

    // Handle wrap-around (shortest path)
    if (difference > Math.PI) {
      difference -= 2 * Math.PI;
    } else if (difference < -Math.PI) {
      difference += 2 * Math.PI;
    }

    // Apply rotation speed limit
    const maxRotationThisFrame = ROTATION_SPEED * deltaTime;
    const actualRotation = Math.sign(difference) * Math.min(Math.abs(difference), maxRotationThisFrame);

    return current + actualRotation;
  }

  /** Main animation loop: update meshes to reflect game state */
  function animate() {
    requestAnimationFrame(animate);

    // Get delta time once per frame
    const deltaTime = clock.getDelta();

    // Update players
    const existingPlayerIds = new Set(playerMeshes.keys());
    for (const p of gameState.players) {
      existingPlayerIds.delete(p.id);
      let mesh = playerMeshes.get(p.id);
      if (!mesh) {
        if (bearModel) {
          // Clone the bear model using SkeletonUtils for proper animation support
          mesh = THREE.SkeletonUtils.clone(bearModel);
          mesh.traverse((child) => {
            if (child instanceof THREE.Mesh && child.material) {
              child.material = child.material.clone(); // Avoid sharing materials between players
            }
          });

          // Initial rotation will be set by the rotation system
          // Left team on left side faces right toward center, right team on right side faces left toward center
          const initialRotation = p.team === 'left' ? Math.PI / 2 : -Math.PI / 2;
          mesh.rotation.y = initialRotation;

          // Set up animation mixer for this player
          if (bearAnimations.length > 0) {
            const mixer = new THREE.AnimationMixer(mesh);
            playerMixers.set(p.id, mixer);

            // Always take the first animation in the GLB
            const action = mixer.clipAction(bearAnimations[0]);
            action.setLoop(THREE.LoopRepeat);
            action.clampWhenFinished = false;
            action.enable = true;
            action.setEffectiveTimeScale(1);
            action.setEffectiveWeight(1);
            action.play();

            console.log(`✓ Playing animation "${bearAnimations[0].name}" for player ${p.id}`);
            console.log(`  Animation enabled: ${action.enabled}, paused: ${action.paused}, time: ${action.time}`);
            
            // Save state so we can update mixer later
            playerAnimationStates.set(p.id, {
              currentAction: action
            });

            console.log(`✓ Playing animation "${bearAnimations[0].name}" for player ${p.id}`);
          }


          scene.add(mesh);
          playerMeshes.set(p.id, mesh);
        } else {
          // Fallback: Use original primitive shapes if model not loaded yet
          const group = new THREE.Group();
          // Body
          const bodyGeo = new THREE.CylinderGeometry(4, 4, 12, 16);
          const bodyMat = new THREE.MeshLambertMaterial({ color: p.team === 'left' ? 0x007bff : 0xe91e63 });
          const body = new THREE.Mesh(bodyGeo, bodyMat);
          body.position.set(0, 6, 0);
          group.add(body);
          // Head
          const headGeo = new THREE.SphereGeometry(3.5, 16, 16);
          const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
          const head = new THREE.Mesh(headGeo, headMat);
          head.position.set(0, 13, 0);
          group.add(head);
          // Add group to scene
          scene.add(group);
          playerMeshes.set(p.id, group);
          mesh = group;
        }
      }

      // Calculate actual movement direction based on position changes
      let actualMovementX = 0;
      let actualMovementY = 0;
      let isActuallyMoving = false;

      const prevPos = playerPreviousPositions.get(p.id);
      if (prevPos) {
        const deltaX = p.x - prevPos.x;
        const deltaY = p.y - prevPos.y;
        const movementThreshold = 0.1; // Minimum movement to consider as "moving"

        if (Math.abs(deltaX) > movementThreshold || Math.abs(deltaY) > movementThreshold) {
          // Normalize the movement direction
          const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
          if (magnitude > 0) {
            actualMovementX = deltaX / magnitude;
            actualMovementY = deltaY / magnitude;
            isActuallyMoving = true;
          }
        }
      }

      // Update position and store current position as previous for next frame
      mesh.position.set(p.x, 12, p.y);
      playerPreviousPositions.set(p.id, { x: p.x, y: p.y });

      // Handle rotation for bear models
      if (bearModel && playerMeshes.get(p.id) === mesh) {
        // Initialize rotation data if not exists
        if (!playerRotationData.has(p.id)) {
          playerRotationData.set(p.id, {
            currentRotation: mesh.rotation.y,
            targetRotation: mesh.rotation.y
          });
        }

        const rotationData = playerRotationData.get(p.id);

        // For the current player, use input direction for immediate response, 
        // but fall back to actual movement for accuracy
        let targetRotation = null;
        if (p.id === playerId) {
          // Current player: prioritize input direction for responsiveness
          if (currentDirection.x !== 0 || currentDirection.y !== 0) {
            targetRotation = calculateTargetRotation(currentDirection.x, currentDirection.y, p.team);
          } else if (isActuallyMoving) {
            targetRotation = calculateTargetRotation(actualMovementX, actualMovementY, p.team);
          }
        } else {
          // Other players: use actual movement direction
          if (isActuallyMoving) {
            targetRotation = calculateTargetRotation(actualMovementX, actualMovementY, p.team);
          }
        }

        if (targetRotation !== null) {
          rotationData.targetRotation = targetRotation;
        }

        // Smoothly interpolate to target rotation
        rotationData.currentRotation = interpolateRotation(
          rotationData.currentRotation,
          rotationData.targetRotation,
          deltaTime
        );

        // Apply rotation to the mesh
        mesh.rotation.y = rotationData.currentRotation;

        // Handle animation transitions based on movement
        const animState = playerAnimationStates.get(p.id);
        if (animState && animState.currentAction) {
          // For current player, use input; for others, use actual movement
          const isMoving = p.id === playerId
            ? (currentDirection.x !== 0 || currentDirection.y !== 0)
            : isActuallyMoving;

          // Pause animation when not moving, play when moving
          if (isMoving) {
            if (animState.currentAction.paused) {
              animState.currentAction.paused = false;
            }
          } else {
            if (!animState.currentAction.paused) {
              animState.currentAction.paused = true;
            }
          }
        }
      }
    }
    // Remove players that no longer exist
    for (const id of existingPlayerIds) {
      const mesh = playerMeshes.get(id);
      if (mesh) {
        scene.remove(mesh);
      }
      // Clean up animation mixer
      const mixer = playerMixers.get(id);
      if (mixer) {
        mixer.stopAllAction();
        playerMixers.delete(id);
      }
      // Clean up animation state, rotation data, and previous positions
      playerAnimationStates.delete(id);
      playerRotationData.delete(id);
      playerPreviousPositions.delete(id);
      playerMeshes.delete(id);
    }
    // Update balls
    const existingBallIds = new Set(ballMeshes.keys());
    for (const b of gameState.balls) {
      existingBallIds.delete(b.id);
      let mesh = ballMeshes.get(b.id);
      if (!mesh) {
        // Create a new ball mesh
        if (footballModel) {
          // Use the football 3D model
          mesh = footballModel.clone();
          mesh.traverse((child) => {
            if (child instanceof THREE.Mesh && child.material) {
              child.material = child.material.clone(); // Avoid sharing materials between footballs
            }
          });
          scene.add(mesh);
          ballMeshes.set(b.id, mesh);
        } else {
          // Fallback: Use yellow sphere if football model not loaded yet
          const ballGeo = new THREE.SphereGeometry(3, 16, 16);
          const ballMat = new THREE.MeshLambertMaterial({ color: 0xffdd00 });
          const ball = new THREE.Mesh(ballGeo, ballMat);
          scene.add(ball);
          ballMeshes.set(b.id, ball);
          mesh = ball;
        }
      }
      mesh.position.set(b.x, 3, b.y);
    }
    // Remove old balls
    for (const id of existingBallIds) {
      const mesh = ballMeshes.get(id);
      if (mesh) {
        scene.remove(mesh);
      }
      ballMeshes.delete(id);
    }

    // Update scoreboard
    updateScoreboard();

    // Update animation mixers

    if (playerMixers.size > 0) {
      for (const [playerId, mixer] of playerMixers.entries()) {
        mixer.update(deltaTime);

        // Debug: Occasionally log mixer state (every 2 seconds)
        if (Math.random() < 0.008) { // ~1/120 chance
          const actions = mixer._actions;
          console.log(`Player ${playerId} mixer update - deltaTime: ${deltaTime.toFixed(4)}`);
          console.log(`  Actions: ${actions.length}`);
          actions.forEach((action, i) => {
            console.log(`  Action ${i}: "${action._clip.name}", time: ${action.time.toFixed(2)}, enabled: ${action.enabled}, weight: ${action.weight}, duration: ${action._clip.duration.toFixed(2)}`);
          });
        }
      }
    } else {
      // Debug when no mixers are found
      if (Math.random() < 0.001) { // Very occasional
        console.log('No animation mixers found - checking if bear model is loaded:', bearModel !== null);
      }
    }

    renderer.render(scene, camera);
  }

  // Kick off everything
  initSocket();
  initScene();
  initInput();
  animate();
})();