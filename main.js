/* ==========================================================================
   3D Map Viewer – main.js
   Loads map.glb with Three.js, auto-fits the camera, and provides
   orbit / zoom / pan controls with damping, view presets and display toggles.
   ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* -------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */

const CONFIG = Object.freeze({
    modelUrl: 'map.glb',
    normalizedSize: 100,
    fov: 45,
    fitMargin: 0.86,
    maxPixelRatio: 2,
    panPadding: 0.12,
    minDistanceRatio: 0.015,
    maxDistanceFactor: 2.5,
    maxPolarAngle: Math.PI * 0.495,
    dracoPath: 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/',
    flyDuration: 900,
    buildingFlyDuration: 1200,
    hintDuration: 6500
});

const ISO_DIRECTION = new THREE.Vector3(1, 0.85, 1).normalize();
const TOP_DIRECTION = new THREE.Vector3(0, 1, 0.001).normalize();

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;

/* -------------------------------------------------------------------------
   DOM
   ------------------------------------------------------------------------- */

const $ = (selector) => document.querySelector(selector);

const el = {
    app: $('#app'),
    viewer: $('#viewer'),
    canvas: $('#viewport'),
    loader: $('#loader'),
    loaderBar: $('#loader-bar'),
    loaderFill: $('#loader-fill'),
    loaderStatus: $('#loader-status'),
    loaderPercent: $('#loader-percent'),
    error: $('#error'),
    errorTitle: $('#error-title'),
    errorMessage: $('#error-message'),
    errorDetails: $('#error-details'),
    retry: $('#error-retry'),
    info: $('#info'),
    stats: $('#stats'),
    hint: $('#hint'),
    toolbar: $('#toolbar'),
    compass: $('#compass'),
    compassDial: $('#compass-dial'),
    fullscreenBtn: $('#btn-fullscreen'),
    fullscreenIcon: $('#fs-use'),
    themeMeta: document.querySelector('meta[name="theme-color"]'),

    // Buildings navigation
    buildingsNav: $('#buildings-nav'),
    buildingsMenu: $('#buildings-menu'),
    buildingsToggle: $('#buildings-toggle'),
    buildingsToggleText: $('#buildings-toggle-text'),
    buildingsDropdown: $('#buildings-dropdown')
};

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */

const state = {
    model: null,
    grid: null,
    materials: [],
    bounds: new THREE.Box3(),
    panBounds: null,
    center: new THREE.Vector3(),
    size: new THREE.Vector3(),
    radius: 1,
    homeDistance: 100,
    needsRender: true,
    resizePending: true,
    anim: null,
    wireframe: false,
    hintTimer: 0,
    loader: null,

    // Building navigation
    buildings: new Map(),
    selectedBuilding: null
};

let renderer, scene, camera, controls, sun, hemi;
let lastDpr = 0;
let lastTime = performance.now();
let lastAzimuth = NaN;

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

init();

function init() {
    window.__MAP_VIEWER_BOOTED__ = true;

    setTheme(
        window.matchMedia('(prefers-color-scheme: light)').matches ?
        'light' :
        'dark'
    );

    setupUI();
    showLoader();

    if (!createRenderer()) return;

    createScene();
    createControls();
    createLoaderPipeline();
    observeResize();
    loadModel();

    requestAnimationFrame(tick);
}

/* -------------------------------------------------------------------------
   Renderer / scene / controls
   ------------------------------------------------------------------------- */

function createRenderer() {
    try {
        renderer = new THREE.WebGLRenderer({
            canvas: el.canvas,
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance'
        });
    } catch (err) {
        console.error(err);

        showError(
            'WebGL is not available',
            'Your browser or device could not start 3D graphics. Enable hardware acceleration or try a different browser.',
            err && err.message
        );

        return false;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x000000, 0);

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    el.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();

        showError(
            'Graphics context lost',
            'The browser reset the GPU connection. It should recover automatically; if not, reload the page.'
        );
    });

    el.canvas.addEventListener('webglcontextrestored', () => {
        hideError();
        requestRender();
    });

    return true;
}

function createScene() {
    scene = new THREE.Scene();

    const pmrem = new THREE.PMREMGenerator(renderer);

    scene.environment = pmrem.fromScene(
        new RoomEnvironment(),
        0.04
    ).texture;

    scene.environmentIntensity = 0.75;

    pmrem.dispose();

    hemi = new THREE.HemisphereLight(
        0xffffff,
        0x8a94a6,
        0.45
    );

    scene.add(hemi);

    sun = new THREE.DirectionalLight(
        0xfff3e2,
        2.4
    );

    sun.castShadow = true;

    sun.shadow.mapSize.set(
        IS_TOUCH ? 1024 : 2048,
        IS_TOUCH ? 1024 : 2048
    );

    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;

    scene.add(sun);
    scene.add(sun.target);

    camera = new THREE.PerspectiveCamera(
        CONFIG.fov,
        1,
        0.05,
        5000
    );

    camera.position.set(80, 60, 80);
}

function createControls() {
    controls = new OrbitControls(
        camera,
        el.canvas
    );

    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = IS_TOUCH ? 0.6 : 0.7;
    controls.panSpeed = 0.9;
    controls.zoomSpeed = 0.9;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.maxPolarAngle = CONFIG.maxPolarAngle;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 1.5;

    controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN
    };

    controls.addEventListener('start', () => {
        // User interaction always wins over camera animation.
        state.anim = null;

        el.viewer.classList.add('is-dragging');
        hideHint();
    });

    controls.addEventListener('end', () => {
        el.viewer.classList.remove('is-dragging');
    });

    controls.addEventListener('change', () => {
        clampTarget();
        state.needsRender = true;
    });
}

function createLoaderPipeline() {
    const draco = new DRACOLoader();

    draco.setDecoderPath(CONFIG.dracoPath);

    state.loader = new GLTFLoader();

    state.loader.setDRACOLoader(draco);
    state.loader.setMeshoptDecoder(MeshoptDecoder);
}

/* -------------------------------------------------------------------------
   Model loading
   ------------------------------------------------------------------------- */

function loadModel() {
    showLoader();

    setProgress(null, 0);

    el.loaderStatus.textContent = 'Downloading map.glb…';

    state.loader.load(
        CONFIG.modelUrl,
        onModelLoaded,
        (event) => {
            if (event.lengthComputable && event.total > 0) {
                const ratio = Math.min(
                    1,
                    event.loaded / event.total
                );

                setProgress(ratio, event.loaded);

                if (ratio >= 1) {
                    el.loaderStatus.textContent = 'Preparing scene…';
                }
            } else {
                setProgress(null, event.loaded);
            }
        },
        onModelError
    );
}

function onModelLoaded(gltf) {
    el.loaderStatus.textContent = 'Preparing scene…';

    requestAnimationFrame(() => {
        try {
            prepareModel(gltf);
        } catch (err) {
            console.error(err);

            showError(
                'Unable to display the map',
                err.message || 'The model could not be processed.',
                ''
            );

            return;
        }

        resize();

        const view = getView(ISO_DIRECTION);

        camera.position.copy(view.position);
        controls.target.copy(view.target);

        controls.update();

        renderer.shadowMap.needsUpdate = true;

        render();

        enableModelUI();
        setupBuildings();

        hideLoader();
        showHint();
    });
}

function onModelError(err) {
    console.error('Failed to load map.glb', err);

    const onDisk = location.protocol === 'file:';

    const message = onDisk ?
        'Browsers block loading local files when a page is opened directly from disk. Serve this folder with a local web server (for example "python -m http.server") or upload it to a web host.' :
        'Make sure map.glb is in the same folder as index.html, that it is a valid GLB file, and that your connection is working.';

    let details = '';

    if (err instanceof Error) {
        details = err.message;
    } else if (err && err.target && err.target.status) {
        details = 'HTTP status ' + err.target.status;
    } else if (err && err.message) {
        details = err.message;
    }

    showError(
        'Could not load map.glb',
        message,
        details
    );
}

function prepareModel(gltf) {
    const root = gltf.scene;

    root.updateMatrixWorld(true);

    const rawBox = new THREE.Box3().setFromObject(root);

    if (rawBox.isEmpty()) {
        throw new Error(
            'map.glb does not contain any visible geometry.'
        );
    }

    const rawSize = rawBox.getSize(
        new THREE.Vector3()
    );

    const rawCenter = rawBox.getCenter(
        new THREE.Vector3()
    );

    const maxDim = Math.max(
        rawSize.x,
        rawSize.y,
        rawSize.z
    );

    if (!Number.isFinite(maxDim) || maxDim <= 0) {
        throw new Error(
            'The model has invalid dimensions.'
        );
    }

    // Normalize model.
    const scale =
        CONFIG.normalizedSize / maxDim;

    const model = new THREE.Group();

    model.name = 'MapRoot';

    model.add(root);

    model.scale.setScalar(scale);

    model.position.set(-rawCenter.x * scale, -rawBox.min.y * scale, -rawCenter.z * scale);

    model.updateMatrixWorld(true);

    state.bounds.setFromObject(model);

    state.bounds.getCenter(state.center);

    state.bounds.getSize(state.size);

    state.radius = state.size.length() / 2;

    // Meshes, materials, statistics.
    const maxAniso = Math.min(
        8,
        renderer.capabilities.getMaxAnisotropy()
    );

    const textureKeys = [
        'map',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'emissiveMap'
    ];

    const materials = new Set();

    let meshCount = 0;
    let triangles = 0;

    model.traverse((obj) => {
        if (!obj.isMesh) return;

        meshCount++;

        obj.castShadow = true;
        obj.receiveShadow = true;

        const geometry = obj.geometry;

        if (
            geometry &&
            geometry.attributes.position
        ) {
            const count = geometry.index ?
                geometry.index.count :
                geometry.attributes.position.count;

            triangles +=
                (count / 3) *
                (obj.isInstancedMesh ? obj.count : 1);
        }

        const list = Array.isArray(obj.material) ?
            obj.material :
            [obj.material];

        list.forEach((mat) => {
            if (!mat || materials.has(mat)) return;

            materials.add(mat);

            textureKeys.forEach((key) => {
                if (mat[key]) {
                    mat[key].anisotropy = maxAniso;
                }
            });
        });
    });

    state.materials = [...materials];

    // Camera clipping planes.
    camera.near = Math.max(
        0.02,
        CONFIG.normalizedSize * 0.0004
    );

    camera.far = state.radius * 60;

    camera.updateProjectionMatrix();

    // Sun and shadow frustum.
    const sunOffset = new THREE.Vector3(
            0.6,
            1,
            0.4
        )
        .normalize()
        .multiplyScalar(state.radius * 2);

    sun.position
        .copy(state.center)
        .add(sunOffset);

    sun.target.position.copy(state.center);

    const shadowCam = sun.shadow.camera;

    shadowCam.left = -state.radius;
    shadowCam.right = state.radius;
    shadowCam.top = state.radius;
    shadowCam.bottom = -state.radius;
    shadowCam.near = 0.1;
    shadowCam.far = state.radius * 4.5;

    shadowCam.updateProjectionMatrix();

    // Reference grid.
    const gridSize = Math.max(
        10,
        Math.ceil(
            (Math.max(state.size.x, state.size.z) * 2.2) / 10
        ) * 10
    );

    const grid = new THREE.GridHelper(
        gridSize,
        Math.round(gridSize / 5),
        0x8a94a6,
        0x8a94a6
    );

    grid.position.set(
        state.center.x,
        state.bounds.min.y -
        Math.max(0.2, state.radius * 0.002),
        state.center.z
    );

    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    grid.material.depthWrite = false;
    grid.material.toneMapped = false;
    grid.renderOrder = -1;

    state.grid = grid;

    scene.add(grid);
    scene.add(model);

    state.model = model;

    // Pan limits.
    const pad =
        Math.max(state.size.x, state.size.z) *
        CONFIG.panPadding;

    state.panBounds = state.bounds
        .clone()
        .expandByVector(
            new THREE.Vector3(
                pad,
                pad * 0.25,
                pad
            )
        );

    // Everything is static.
    scene.updateMatrixWorld(true);

    model.traverse((obj) => {
        obj.matrixAutoUpdate = false;
    });

    scene.matrixWorldAutoUpdate = false;

    updateLimits();

    const fmt = new Intl.NumberFormat();

    el.stats.textContent =
        `${fmt.format(meshCount)} meshes · ` +
        `${fmt.format(Math.round(triangles))} triangles · ` +
        `${formatLength(rawSize.x)} × ` +
        `${formatLength(rawSize.z)}`;

    el.info.hidden = false;
    el.compass.hidden = false;
}

/* -------------------------------------------------------------------------
   Buildings navigation
   ------------------------------------------------------------------------- */

/*
 * The three buildings currently configured in index.html:
 *
 * Building 1 -> Obj_SubDMesh_107
 * Building 2 -> Obj_SubDMesh_141
 * Building 3 -> Obj_SubDMesh_207
 */

function setupBuildings() {
    if (!el.buildingsDropdown) return;

    state.buildings.clear();

    const buildingButtons =
        el.buildingsDropdown.querySelectorAll(
            '.building-item'
        );

    buildingButtons.forEach((button) => {
        const objectName =
            button.dataset.building;

        const buildingName =
            button.dataset.buildingName ||
            button.textContent.trim();

        if (!objectName) return;

        const object =
            findObjectByName(objectName);

        if (!object) {
            console.warn(
                `Building object "${objectName}" was not found in map.glb.`
            );

            button.disabled = true;
            button.title = 'Building not found in the 3D model.';

            return;
        }

        state.buildings.set(
            objectName, {
                object,
                name: buildingName,
                button
            }
        );

        button.disabled = false;

        button.addEventListener(
            'click',
            () => {
                goToBuilding(objectName);
            }
        );
    });

    el.buildingsToggle.disabled =
        state.buildings.size === 0;
}

function findObjectByName(name) {
    if (!state.model) return null;

    let result = null;

    state.model.traverse((object) => {
        if (result) return;

        if (object.name === name) {
            result = object;
        }
    });

    return result;
}

function goToBuilding(objectName) {
    if (!state.model) return;

    const building =
        state.buildings.get(objectName);

    if (!building || !building.object) {
        console.warn(
            `Building "${objectName}" is not available.`
        );

        return;
    }

    const object = building.object;

    // Make sure world matrices are current.
    object.updateMatrixWorld(true);

    const box = new THREE.Box3()
        .setFromObject(object);

    if (box.isEmpty()) {
        console.warn(
            `Building "${objectName}" has no visible geometry.`
        );

        return;
    }

    const center = box.getCenter(
        new THREE.Vector3()
    );

    const size = box.getSize(
        new THREE.Vector3()
    );

    /*
     * We calculate a camera distance based on the building's
     * dimensions so the building appears clearly in the view.
     */

    const maxDimension = Math.max(
        size.x,
        size.y,
        size.z
    );

    const verticalFov =
        THREE.MathUtils.degToRad(camera.fov);

    const horizontalFov =
        2 *
        Math.atan(
            Math.tan(verticalFov / 2) *
            camera.aspect
        );

    const verticalDistance =
        (maxDimension * 0.75) /
        Math.tan(verticalFov / 2);

    const horizontalDistance =
        (maxDimension * 0.75) /
        Math.tan(horizontalFov / 2);

    let distance = Math.max(
        verticalDistance,
        horizontalDistance
    );

    /*
     * Make sure the camera is not too close to the building.
     */
    distance = Math.max(
        distance,
        CONFIG.normalizedSize *
        CONFIG.minDistanceRatio *
        8
    );

    /*
     * Don't allow the building view to be farther
     * than the normal maximum camera distance.
     */
    distance = Math.min(
        distance,
        controls.maxDistance * 0.75
    );

    /*
     * Use the same isometric direction used by the
     * initial camera view.
     */
    const direction =
        ISO_DIRECTION.clone().normalize();

    const position =
        center.clone()
        .addScaledVector(direction, distance);

    const view = {
        position,
        target: center
    };

    state.selectedBuilding = objectName;

    updateBuildingSelection(
        objectName,
        building.name
    );

    closeBuildingsMenu();

    hideHint();

    flyTo(
        view,
        CONFIG.buildingFlyDuration
    );
}

function updateBuildingSelection(
    objectName,
    buildingName
) {
    if (!el.buildingsDropdown) return;

    const buttons =
        el.buildingsDropdown.querySelectorAll(
            '.building-item'
        );

    buttons.forEach((button) => {
        const selected =
            button.dataset.building === objectName;

        button.setAttribute(
            'aria-current',
            selected ? 'true' : 'false'
        );
    });

    if (el.buildingsToggleText) {
        el.buildingsToggleText.textContent =
            buildingName || 'Buildings';
    }
}

function toggleBuildingsMenu() {
    if (!el.buildingsMenu ||
        !el.buildingsToggle
    ) {
        return;
    }

    const isOpen =
        el.buildingsMenu.classList.contains(
            'is-open'
        );

    if (isOpen) {
        closeBuildingsMenu();
    } else {
        openBuildingsMenu();
    }
}

function openBuildingsMenu() {
    if (!el.buildingsMenu ||
        !el.buildingsToggle
    ) {
        return;
    }

    el.buildingsMenu.classList.add('is-open');

    el.buildingsToggle.setAttribute(
        'aria-expanded',
        'true'
    );
}

function closeBuildingsMenu() {
    if (!el.buildingsMenu ||
        !el.buildingsToggle
    ) {
        return;
    }

    el.buildingsMenu.classList.remove(
        'is-open'
    );

    el.buildingsToggle.setAttribute(
        'aria-expanded',
        'false'
    );
}

/* -------------------------------------------------------------------------
   Camera framing
   ------------------------------------------------------------------------- */

const _tmpCam =
    new THREE.PerspectiveCamera();

const _corners =
    Array.from({ length: 8 },
        () => new THREE.Vector3()
    );

const _proj =
    new THREE.Vector3();

/**
 * Finds the smallest camera distance along direction
 * from the map centre at which all eight bounding-box
 * corners fit inside the screen margin.
 */
function computeFitDistance(direction) {
    const { min, max } = state.bounds;

    let i = 0;

    for (const x of[min.x, max.x]) {
        for (const y of[min.y, max.y]) {
            for (const z of[min.z, max.z]) {
                _corners[i++].set(
                    x,
                    y,
                    z
                );
            }
        }
    }

    _tmpCam.fov = camera.fov;
    _tmpCam.aspect = camera.aspect;
    _tmpCam.near = camera.near;
    _tmpCam.far = camera.far;

    _tmpCam.updateProjectionMatrix();

    const fits = (distance) => {
        _tmpCam.position
            .copy(state.center)
            .addScaledVector(
                direction,
                distance
            );

        _tmpCam.lookAt(state.center);

        _tmpCam.updateMatrixWorld(true);

        let extent = 0;

        for (const corner of _corners) {
            _proj
                .copy(corner)
                .project(_tmpCam);

            extent = Math.max(
                extent,
                Math.abs(_proj.x),
                Math.abs(_proj.y)
            );
        }

        return extent <= CONFIG.fitMargin;
    };

    let lo = state.radius * 1.01;
    let hi = state.radius * 40;

    for (let i2 = 0; i2 < 28; i2++) {
        const mid =
            (lo + hi) / 2;

        if (fits(mid)) {
            hi = mid;
        } else {
            lo = mid;
        }
    }

    return hi;
}

function getView(direction) {
    const distance =
        computeFitDistance(direction);

    return {
        position: state.center
            .clone()
            .addScaledVector(
                direction,
                distance
            ),

        target: state.center.clone()
    };
}

function updateLimits() {
    state.homeDistance =
        computeFitDistance(
            ISO_DIRECTION
        );

    controls.minDistance =
        CONFIG.normalizedSize *
        CONFIG.minDistanceRatio;

    controls.maxDistance =
        state.homeDistance *
        CONFIG.maxDistanceFactor;
}

const _before =
    new THREE.Vector3();

const _shift =
    new THREE.Vector3();

function clampTarget() {
    if (!state.panBounds) return;

    _before.copy(
        controls.target
    );

    controls.target.clamp(
        state.panBounds.min,
        state.panBounds.max
    );

    _shift.subVectors(
        controls.target,
        _before
    );

    if (_shift.lengthSq() > 0) {
        camera.position.add(_shift);
    }
}

/* -------------------------------------------------------------------------
   Smooth camera transitions
   ------------------------------------------------------------------------- */

const _sphere =
    new THREE.Spherical();

const _offset =
    new THREE.Vector3();

function easeInOutCubic(t) {
    return t < 0.5 ?
        4 * t * t * t :
        1 -
        Math.pow(-2 * t + 2,
            3
        ) / 2;
}

function flyTo(
    view,
    duration = CONFIG.flyDuration
) {
    if (
        REDUCED_MOTION ||
        duration <= 0
    ) {
        camera.position.copy(
            view.position
        );

        controls.target.copy(
            view.target
        );

        state.anim = null;

        controls.update();

        requestRender();

        return;
    }

    const fromTarget =
        controls.target.clone();

    const fromS =
        new THREE.Spherical()
        .setFromVector3(
            camera.position
            .clone()
            .sub(fromTarget)
        );

    const toS =
        new THREE.Spherical()
        .setFromVector3(
            view.position
            .clone()
            .sub(view.target)
        );

    // Shortest angular path.
    const dTheta =
        THREE.MathUtils.euclideanModulo(
            toS.theta -
            fromS.theta +
            Math.PI,
            Math.PI * 2
        ) - Math.PI;

    state.anim = {
        t0: performance.now(),
        duration,
        fromTarget,
        toTarget: view.target.clone(),
        fromS,
        toS,
        dTheta
    };

    requestRender();
}

function stepAnimation(now) {
    const a = state.anim;

    if (!a) return;

    const t = Math.min(
        1,
        (now - a.t0) /
        a.duration
    );

    const e =
        easeInOutCubic(t);

    controls.target.lerpVectors(
        a.fromTarget,
        a.toTarget,
        e
    );

    _sphere.radius =
        THREE.MathUtils.lerp(
            a.fromS.radius,
            a.toS.radius,
            e
        );

    _sphere.phi =
        THREE.MathUtils.lerp(
            a.fromS.phi,
            a.toS.phi,
            e
        );

    _sphere.theta =
        a.fromS.theta +
        a.dTheta * e;

    _offset.setFromSpherical(
        _sphere
    );

    camera.position.copy(
        controls.target
    ).add(_offset);

    camera.lookAt(
        controls.target
    );

    if (t >= 1) {
        state.anim = null;
    }
}

function zoomBy(factor) {
    _offset
        .copy(camera.position)
        .sub(controls.target);

    const distance =
        THREE.MathUtils.clamp(
            _offset.length() * factor,
            controls.minDistance,
            controls.maxDistance
        );

    _offset.setLength(
        distance
    );

    flyTo({
            position: controls.target
                .clone()
                .add(_offset),

            target: controls.target.clone()
        },
        260
    );
}

function alignNorth() {
    _offset
        .copy(camera.position)
        .sub(controls.target);

    const s =
        new THREE.Spherical()
        .setFromVector3(
            _offset
        );

    s.theta = 0;

    _offset.setFromSpherical(s);

    flyTo({
            position: controls.target
                .clone()
                .add(_offset),

            target: controls.target.clone()
        },
        600
    );
}

/* -------------------------------------------------------------------------
   Render loop
   ------------------------------------------------------------------------- */

function requestRender() {
    state.needsRender = true;
}

function tick(now) {
    requestAnimationFrame(tick);

    const dt = Math.min(
        (now - lastTime) / 1000,
        0.1
    );

    lastTime = now;

    if (state.resizePending) {
        state.resizePending = false;
        resize();
    }

    stepAnimation(now);

    const moved =
        controls.update(dt);

    if (
        moved ||
        state.needsRender ||
        state.anim
    ) {
        render();
    }
}

function render() {
    renderer.render(
        scene,
        camera
    );

    state.needsRender = false;

    updateCompass();
}

function updateCompass() {
    const azimuth =
        controls.getAzimuthalAngle();

    if (
        Math.abs(
            azimuth -
            lastAzimuth
        ) < 1e-3
    ) {
        return;
    }

    lastAzimuth = azimuth;

    el.compassDial.style.transform =
        `rotate(${azimuth}rad)`;
}

/* -------------------------------------------------------------------------
   Resize
   ------------------------------------------------------------------------- */

function observeResize() {
    const schedule = () => {
        state.resizePending = true;
    };

    new ResizeObserver(
        schedule
    ).observe(el.viewer);

    window.addEventListener(
        'resize',
        schedule, { passive: true }
    );

    window.addEventListener(
        'orientationchange',
        schedule, { passive: true }
    );
}

function resize() {
    const width =
        el.viewer.clientWidth;

    const height =
        el.viewer.clientHeight;

    if (!width || !height) {
        return;
    }

    const dpr = Math.min(
        window.devicePixelRatio || 1,
        CONFIG.maxPixelRatio
    );

    if (dpr !== lastDpr) {
        renderer.setPixelRatio(dpr);
        lastDpr = dpr;
    }

    renderer.setSize(
        width,
        height,
        false
    );

    camera.aspect =
        width / height;

    camera.updateProjectionMatrix();

    if (state.model) {
        updateLimits();
    }

    requestRender();
}

/* -------------------------------------------------------------------------
   UI: actions, toggles, keyboard, fullscreen, theme
   ------------------------------------------------------------------------- */

function setupUI() {
    el.retry.onclick = null;

    el.retry.addEventListener(
        'click',
        () => {
            if (
                state.model ||
                !state.loader
            ) {
                location.reload();
            } else {
                loadModel();
            }
        }
    );

    el.toolbar.addEventListener(
        'click',
        (event) => {
            const button =
                event.target.closest(
                    '[data-action]'
                );

            if (!button ||
                button.disabled
            ) {
                return;
            }

            runAction(
                button.dataset.action
            );
        }
    );

    el.compass.addEventListener(
        'click',
        alignNorth
    );

    /*
     * Buildings dropdown.
     */
    if (
        el.buildingsToggle &&
        el.buildingsMenu
    ) {
        el.buildingsToggle.addEventListener(
            'click',
            (event) => {
                event.stopPropagation();
                toggleBuildingsMenu();
            }
        );
    }

    if (el.buildingsDropdown) {
        el.buildingsDropdown.addEventListener(
            'click',
            (event) => {
                event.stopPropagation();
            }
        );
    }

    /*
     * Close buildings menu when clicking outside it.
     */
    document.addEventListener(
        'click',
        (event) => {
            if (!el.buildingsMenu ||
                !el.buildingsMenu.contains(
                    event.target
                )
            ) {
                closeBuildingsMenu();
            }
        }
    );

    /*
     * Escape closes the buildings menu.
     */
    window.addEventListener(
        'keydown',
        (event) => {
            if (event.key === 'Escape') {
                closeBuildingsMenu();
            }
        }
    );

    window.addEventListener(
        'keydown',
        (event) => {
            if (
                event.ctrlKey ||
                event.metaKey ||
                event.altKey
            ) {
                return;
            }

            const tag =
                event.target &&
                event.target.tagName;

            if (
                tag === 'INPUT' ||
                tag === 'TEXTAREA' ||
                tag === 'SELECT'
            ) {
                return;
            }

            const keyMap = {
                r: 'reset',
                t: 'top',
                '+': 'zoom-in',
                '=': 'zoom-in',
                '-': 'zoom-out',
                _: 'zoom-out',
                a: 'rotate',
                g: 'grid',
                w: 'wireframe',
                s: 'shadows',
                l: 'theme',
                f: 'fullscreen'
            };

            const action =
                keyMap[
                    event.key.toLowerCase()
                ];

            if (!action) return;

            const repeatable =
                action === 'zoom-in' ||
                action === 'zoom-out';

            if (
                event.repeat &&
                !repeatable
            ) {
                return;
            }

            event.preventDefault();

            runAction(action);
        }
    );

    // Fullscreen support.
    const fsSupported = !!(
        document.fullscreenEnabled ||
        document.webkitFullscreenEnabled
    );

    if (!fsSupported) {
        el.fullscreenBtn.hidden = true;
    }

    document.addEventListener(
        'fullscreenchange',
        onFullscreenChange
    );

    document.addEventListener(
        'webkitfullscreenchange',
        onFullscreenChange
    );
}

function runAction(action) {
    const needsModel = [
        'reset',
        'top',
        'zoom-in',
        'zoom-out',
        'rotate',
        'grid',
        'wireframe',
        'shadows'
    ];

    if (
        needsModel.includes(action) &&
        !state.model
    ) {
        return;
    }

    switch (action) {
        case 'reset':
            state.selectedBuilding = null;

            updateBuildingSelection(
                null,
                'Buildings'
            );

            flyTo(
                getView(
                    ISO_DIRECTION
                )
            );

            break;

        case 'top':
            flyTo(
                getView(
                    TOP_DIRECTION
                )
            );

            break;

        case 'zoom-in':
            zoomBy(0.62);
            break;

        case 'zoom-out':
            zoomBy(1 / 0.62);
            break;

        case 'rotate':
            controls.autoRotate = !controls.autoRotate;

            setPressed(
                'rotate',
                controls.autoRotate
            );

            hideHint();

            break;

        case 'grid':
            state.grid.visible = !state.grid.visible;

            setPressed(
                'grid',
                state.grid.visible
            );

            requestRender();

            break;

        case 'wireframe':
            state.wireframe = !state.wireframe;

            state.materials.forEach(
                (mat) => {
                    mat.wireframe =
                        state.wireframe;
                }
            );

            setPressed(
                'wireframe',
                state.wireframe
            );

            requestRender();

            break;

        case 'shadows':
            sun.castShadow = !sun.castShadow;

            renderer.shadowMap.needsUpdate =
                true;

            setPressed(
                'shadows',
                sun.castShadow
            );

            requestRender();

            break;

        case 'theme':
            setTheme(
                document.documentElement
                .dataset.theme === 'dark' ?
                'light' :
                'dark'
            );

            break;

        case 'fullscreen':
            toggleFullscreen();
            break;

        default:
            break;
    }
}

function setPressed(
    action,
    pressed
) {
    const button =
        el.toolbar.querySelector(
            `[data-action="${action}"]`
        );

    if (button) {
        button.setAttribute(
            'aria-pressed',
            String(pressed)
        );
    }
}

function enableModelUI() {
    el.toolbar
        .querySelectorAll(
            '[data-needs-model]'
        )
        .forEach((button) => {
            button.disabled = false;
        });
}

function setTheme(theme) {
    document.documentElement.dataset.theme =
        theme;

    if (el.themeMeta) {
        el.themeMeta.content =
            theme === 'dark' ?
            '#0c1018' :
            '#dfe6f1';
    }
}

function toggleFullscreen() {
    const active =
        document.fullscreenElement ||
        document.webkitFullscreenElement;

    try {
        if (active) {
            const exit =
                document.exitFullscreen ||
                document.webkitExitFullscreen;

            const result =
                exit.call(document);

            if (
                result &&
                result.catch
            ) {
                result.catch(() => {});
            }
        } else {
            const request =
                el.app.requestFullscreen ||
                el.app.webkitRequestFullscreen;

            const result =
                request.call(el.app);

            if (
                result &&
                result.catch
            ) {
                result.catch(() => {});
            }
        }
    } catch (err) {
        console.warn(
            'Fullscreen is not available:',
            err
        );
    }
}

function onFullscreenChange() {
    const active = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement
    );

    el.fullscreenBtn.setAttribute(
        'aria-pressed',
        String(active)
    );

    el.fullscreenIcon.setAttribute(
        'href',
        active ?
        '#i-shrink' :
        '#i-expand'
    );

    state.resizePending = true;
}

/* -------------------------------------------------------------------------
   Loader, error and hint UI
   ------------------------------------------------------------------------- */

function showLoader() {
    el.error.hidden = true;

    el.loader.classList.remove(
        'is-hidden'
    );

    el.loader.removeAttribute(
        'aria-hidden'
    );
}

function hideLoader() {
    el.loader.classList.add(
        'is-hidden'
    );

    el.loader.setAttribute(
        'aria-hidden',
        'true'
    );
}

function setProgress(
    ratio,
    loadedBytes
) {
    if (ratio === null) {
        el.loaderBar.classList.add(
            'is-indeterminate'
        );

        el.loaderPercent.textContent =
            loadedBytes > 0 ?
            formatBytes(
                loadedBytes
            ) :
            '';
    } else {
        el.loaderBar.classList.remove(
            'is-indeterminate'
        );

        el.loaderFill.style.transform =
            `scaleX(${ratio})`;

        el.loaderPercent.textContent =
            `${Math.round(
                ratio * 100
            )}%`;
    }
}

function showError(
    title,
    message,
    details
) {
    el.errorTitle.textContent =
        title;

    el.errorMessage.textContent =
        message;

    el.errorDetails.textContent =
        details || '';

    el.errorDetails.hidden = !details;

    hideLoader();

    el.error.hidden = false;
}

function hideError() {
    el.error.hidden = true;
}

function showHint() {
    el.hint.textContent = IS_TOUCH ?
        'Drag to rotate · Pinch to zoom · Two fingers to pan' :
        'Drag to rotate · Scroll to zoom · Right-drag to pan';

    el.hint.classList.add(
        'is-visible'
    );

    clearTimeout(
        state.hintTimer
    );

    state.hintTimer =
        setTimeout(
            hideHint,
            CONFIG.hintDuration
        );
}

function hideHint() {
    clearTimeout(
        state.hintTimer
    );

    el.hint.classList.remove(
        'is-visible'
    );
}

/* -------------------------------------------------------------------------
   Formatting helpers
   ------------------------------------------------------------------------- */

function formatBytes(bytes) {
    if (
        bytes >=
        1024 * 1024
    ) {
        return (
                bytes /
                (1024 * 1024)
            ).toFixed(1) +
            ' MB';
    }

    if (bytes >= 1024) {
        return (
            Math.round(
                bytes / 1024
            ) +
            ' KB'
        );
    }

    return (
        bytes +
        ' B'
    );
}

function formatLength(meters) {
    if (meters >= 1000) {
        return (
                meters / 1000
            ).toFixed(2) +
            ' km';
    }

    if (meters >= 1) {
        return (
            meters.toFixed(1) +
            ' m'
        );
    }

    return (
            meters * 100
        ).toFixed(0) +
        ' cm';
}
