import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { oceanVertex, oceanFragment } from './shaders'
import { loadIceMaps, type IceMaps } from './ice'
import { SnowCover, SnowSystem } from './snow'
import { SpectralOcean } from './SpectralOcean'
import { LightningSystem, RainSystem } from './rain'
import { VolumetricSky } from './VolumetricSky'
import { UnderwaterLighting } from './UnderwaterLighting'
import { WeatherSystem, type WeatherSnapshot } from './weather'
import { presets, qualityOptions, type CameraMode, type WaterSettings } from './settings'

interface SceneCallbacks {
  weather?: (snapshot: WeatherSnapshot) => void
  progress: (percent: number, label: string) => void
  ready: () => void
  error: (message: string) => void
  stats: (fps: number, underwater: boolean, speed: number) => void
}

function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    if (mesh.material) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value)
        }
      }
    }
  })
  textures.forEach(texture => texture.dispose())
  materials.forEach(material => material.dispose())
  geometries.forEach(geometry => geometry.dispose())
}

// 环绕视角能拉到的最大距离，同时也是开场镜头的起点：
// 镜头先从最远处俯瞰，再一路缩放下去。
const MAX_CAMERA_DISTANCE = 650

// 阴天增强时，用平坦的灰色风暴光取代饱和的阳光与天空色。
const overcastAmbient = new THREE.Color('#9fa9b3')
const overcastFog = new THREE.Color('#5a6772')
const overcastWater = new THREE.Color('#33454e')

// Shark.glb 是纯静态网格，没有骨骼也没有动画轨道，硬转整体姿态会像块木头。
// 这里用顶点位移做游动：局部 -X 是头、+X 是尾，头部权重为 0，越靠尾摆幅越大，
// 相位沿体长延迟形成推进波，看起来就是身体在扭动而不是整体在转。
const sharkSwimUniforms = `
uniform float uSwimTime;
uniform float uSwimHead;
uniform float uSwimLength;
uniform float uSwimAmplitude;
uniform float uSwimWaves;
uniform float uSwimSpeed;
`

const sharkSwimWave = `
  float swimT = clamp((position.x - uSwimHead) / uSwimLength, 0.0, 1.0);
  float swimAmp = pow(swimT, 1.9) * uSwimAmplitude;
  float swimSwing = sin(uSwimTime * uSwimSpeed - swimT * uSwimWaves);
  transformed.z += swimSwing * swimAmp;
  // 尾鳍甩到两侧时体长会缩短，不收一点会被明显拉伸。
  transformed.x -= abs(swimSwing) * swimAmp * 0.22;
`

export class OceanScene {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.15, 16000)
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly observer: ResizeObserver
  private readonly events = new AbortController()
  private readonly textures: THREE.Texture[] = []
  private readonly draco = new DRACOLoader()
  private readonly refraction = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
  private readonly sun = new THREE.DirectionalLight(0xfff5df, 2.8)
  private readonly ambient = new THREE.HemisphereLight(0xb4dafa, 0x497477, 1.6)
  private readonly fill = new THREE.DirectionalLight(0xc7dcea, 1.1)
  private readonly flashLight = new THREE.DirectionalLight(0xdce8ff, 0)
  private readonly rainSystem: RainSystem
  private readonly lightning: LightningSystem
  private readonly snowSystem: SnowSystem
  private readonly snowCover = new SnowCover()
  private readonly iceCenter = new THREE.Vector2(-25, -48)
  private iceMaps: IceMaps | null = null
  private iceRadius = 0
  private snowAmount = 0
  private readonly ship = new THREE.Group()
  private readonly hull = new THREE.Group()
  private readonly probes = new THREE.Group()
  private readonly wakeProbes = new THREE.Group()
  private readonly buoys: THREE.Group[] = []
  private readonly fish: THREE.Object3D[] = []
  private shark: THREE.Object3D | null = null
  private readonly wrecks: THREE.Object3D[] = []
  // 开场镜头：先在云层里漂 2 秒，再俯冲穿过云底落回船边。
  private readonly intro = { active: false, elapsed: 0, hold: 2, descent: 5 }
  private readonly flight = {
    active: false,
    elapsed: 0,
    duration: 1.5,
    fromPosition: new THREE.Vector3(),
    fromTarget: new THREE.Vector3(),
    midPosition: new THREE.Vector3(),
    toPosition: new THREE.Vector3(),
    toTarget: new THREE.Vector3()
  }
  private sharkPath: THREE.CatmullRomCurve3 | null = null
  private sharkPathLength = 1
  private sharkProgress = 0
  private sharkYaw = 0
  private sharkRoll = 0
  private readonly sharkPoint = new THREE.Vector3()
  private readonly sharkTangent = new THREE.Vector3()
  private readonly sharkSwim: Record<string, THREE.IUniform> = {
    uSwimTime: { value: 0 },
    uSwimHead: { value: -5 },
    uSwimLength: { value: 9.7 },
    uSwimAmplitude: { value: 0.85 },
    uSwimWaves: { value: 3.1 },
    uSwimSpeed: { value: 3.4 }
  }
  private readonly mixers: THREE.AnimationMixer[] = []
  private readonly keys = new Set<string>()
  private readonly sky: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly atmosphere: VolumetricSky
  private readonly spectrum: SpectralOcean
  private readonly ocean: Reflector
  private readonly material: THREE.ShaderMaterial
  private readonly weather: WeatherSystem
  private environment: THREE.WebGLRenderTarget | null = null
  private environmentGenerator: THREE.PMREMGenerator | undefined
  private lastEnvironmentUpdate = 0
  private lastWeatherStats = 0
  private environmentTimer: ReturnType<typeof setTimeout> | undefined
  private animation = 0
  private disposed = false
  private time = 0
  private lastFrame = 0
  private lastStats = 0
  private frameCount = 0
  private mode: CameraMode = 'orbit'
  private speed = 0
  private heading = -0.12
  private settings: WaterSettings
  private width = 1
  private height = 1
  private readonly underwaterLight = new UnderwaterLighting()
  private underwater = false
  private waterLevel = 0

  constructor(private readonly host: HTMLElement, settings: WaterSettings, private readonly callbacks: SceneCallbacks) {
    this.settings = { ...settings }
    // 初始就把冰面设为当前 freeze 值：滑块读数即当前状态，
    // 而不是页面加载后再慢慢冻出来。
    this.iceRadius = settings.freeze * 220
    this.weather = new WeatherSystem(settings)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.95
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.setAttribute('aria-label', '可交互的海洋三维场景')
    this.renderer.domElement.tabIndex = 0
    host.appendChild(this.renderer.domElement)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.065
    this.controls.minDistance = 3
    this.controls.maxDistance = MAX_CAMERA_DISTANCE
    this.controls.maxPolarAngle = Math.PI * 0.78
    this.controls.target.set(-4, 6, -3)
    this.camera.position.set(17, 11, 37)
    this.controls.update()

    this.refraction.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
    this.sun.position.set(-70, 110, -110)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    Object.assign(this.sun.shadow.camera, { left: -100, right: 100, top: 100, bottom: -100, near: 1, far: 400 })
    this.sun.shadow.bias = -0.00025
    this.sun.shadow.normalBias = 0.035
    this.fill.position.set(28, 42, 65)
    this.fill.color.set('#fff0d7')
    this.flashLight.position.set(180, 320, -150)
    this.rainSystem = new RainSystem(settings.quality)
    this.lightning = new LightningSystem()
    this.snowSystem = new SnowSystem(settings.quality)
    this.scene.add(this.sun, this.ambient, this.fill, this.flashLight, this.rainSystem.mesh, this.lightning.bolt, this.snowSystem.mesh)
    void this.loadIceMaps()

    this.atmosphere = new VolumetricSky(this.renderer, this.camera)
    this.sky = this.atmosphere.mesh
    this.scene.add(this.sky)
    this.spectrum = new SpectralOcean(this.renderer)

    // 线性覆盖度，在 mip 过滤前提取，不是一张灰度照片。
    const foam = this.loadTexture('/water/textures/foam-filaments.png')
    this.ocean = new Reflector(this.waterGeometry(settings.quality), {
      textureWidth: qualityOptions[settings.quality].reflection,
      textureHeight: qualityOptions[settings.quality].reflection,
      multisample: 0, clipBias: 0.002,
      shader: {
        name: 'OceanSurface', vertexShader: oceanVertex, fragmentShader: oceanFragment,
        uniforms: {
          color: { value: new THREE.Color() }, textureMatrix: { value: new THREE.Matrix4() }, tDiffuse: { value: null },
          uTime: { value: 0 }, uWind: { value: settings.wind },
          uTexelOffset: { value: 0.5 / 128 },
          uRefraction: { value: null }, uDepth: { value: null }, uFoam: { value: null },
          uDisplacement0: { value: null }, uDisplacement1: { value: null }, uDisplacement2: { value: null },
          uNormal0: { value: null }, uNormal1: { value: null }, uNormal2: { value: null },
          uSkyEnvironment: { value: null }, uReflectionDepth: { value: null },
          uResolution: { value: new THREE.Vector2() }, uEye: { value: new THREE.Vector3() },
          uSun: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
          uWaterColor: { value: new THREE.Color() }, uFogColor: { value: new THREE.Color() },
          uFog: { value: 0.001 }, uDaylight: { value: 1 }, uNear: { value: this.camera.near }, uFar: { value: this.camera.far },
          uBoat: { value: new THREE.Vector3() }, uBoatSpeed: { value: 0 },
          uRain: { value: 0 }, uOvercast: { value: 0 }, uFlash: { value: 0 },
          uIceCenter: { value: this.iceCenter.clone() }, uIceRadius: { value: 0 },
          uIceCracks: { value: null }, uIcePerlin: { value: null },
        },
      },
    })
    this.material = this.ocean.material as THREE.ShaderMaterial
    this.ocean.getRenderTarget().depthTexture = new THREE.DepthTexture(qualityOptions[settings.quality].reflection, qualityOptions[settings.quality].reflection, THREE.UnsignedIntType)
    this.material.uniforms.uReflectionDepth.value = this.ocean.getRenderTarget().depthTexture
    this.material.uniforms.uSkyEnvironment.value = this.atmosphere.texture
    this.material.side = THREE.DoubleSide
    this.material.uniforms.uRefraction.value = this.refraction.texture
    this.material.uniforms.uDepth.value = this.refraction.depthTexture
    this.material.uniforms.uFoam.value = foam
    this.ocean.rotation.x = -Math.PI / 2
    this.ocean.frustumCulled = false
    this.scene.add(this.ocean)
    this.ship.add(this.hull)
    this.ship.position.set(0, 0, 4)
    this.scene.add(this.ship, this.probes, this.wakeProbes)
    this.createSeabed()
    this.createProbes()
    this.applySettings(settings)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.resize()

    const signal = this.events.signal
    window.addEventListener('keydown', event => {
      if (event.target instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable)) return
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
        event.preventDefault()
        this.keys.add(event.code)
      }
    }, { signal })
    window.addEventListener('keyup', event => this.keys.delete(event.code), { signal })
    window.addEventListener('blur', () => this.keys.clear(), { signal })
    document.addEventListener('visibilitychange', () => { this.lastFrame = 0; this.keys.clear() }, { signal })
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault()
      cancelAnimationFrame(this.animation)
      callbacks.error('图形上下文已中断，请重新加载场景。')
    }, { signal })
    this.animation = requestAnimationFrame(this.frame)
    void this.loadModels()
  }

  private loadTexture(path: string, srgb = false) {
    const texture = new THREE.TextureLoader().load(path, loaded => {
      if (this.disposed) loaded.dispose()
    }, undefined, () => {
      if (!this.disposed) this.callbacks.error(`纹理加载失败：${path}`)
    })
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace
    this.textures.push(texture)
    return texture
  }

  private waterGeometry(quality: WaterSettings['quality']) {
    const geometry = new THREE.PlaneGeometry(2, 2, qualityOptions[quality].segments, qualityOptions[quality].segments)
    const positions = geometry.getAttribute('position')
    // 顶点向船体周围集中，同时保留 12 km 连续的地平线。
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i)
      positions.setXY(i, x * (90 + Math.pow(Math.abs(x), 4) * 6000), y * (90 + Math.pow(Math.abs(y), 4) * 6000))
    }
    geometry.computeBoundingSphere()
    return geometry
  }

  private seabedHeight(x: number, z: number) {
    return -5.4 - Math.min(Math.hypot(x, z + 20) * 0.037, 28) + Math.sin(x * 0.085) * Math.cos(z * 0.07) * 0.85
  }

  private async loadIceMaps() {
    try {
      const maps = await loadIceMaps()
      if (this.disposed) {
        maps.cracks.dispose()
        maps.perlin.dispose()
        return
      }
      this.iceMaps = maps
      this.material.uniforms.uIceCracks.value = maps.cracks
      this.material.uniforms.uIcePerlin.value = maps.perlin
    } catch {
      // 本地贴图读取失败时，冻结效果直接保持关闭。
    }
  }

  /** 着色器冻结锋面的 CPU 副本，用于让船体与浮标静止。 */
  private iceCoverAt(x: number, z: number) {
    if (this.iceRadius <= 0.01) return 0
    const dx = x - this.iceCenter.x
    const dz = z - this.iceCenter.y
    const angle = Math.atan2(dz, dx)
    const wobble = (Math.sin(angle * 3.1 + 1.7) * 0.09 + Math.sin(angle * 7.3 + 0.4) * 0.05 + Math.sin(angle * 13.7) * 0.03) * this.iceRadius
    const front = this.iceRadius + wobble
    return 1 - THREE.MathUtils.smoothstep(Math.hypot(dx, dz), front - 3.5, front + 1.5)
  }

  private createSeabed() {
    const geometry = new THREE.PlaneGeometry(1400, 1400, 180, 180)
    geometry.rotateX(-Math.PI / 2)
    const positions = geometry.getAttribute('position')
    for (let i = 0; i < positions.count; i++) positions.setY(i, this.seabedHeight(positions.getX(i), positions.getZ(i)))
    geometry.computeVertexNormals()
    const sand = this.loadTexture('/water/textures/sand.jpg', true)
    const normal = this.loadTexture('/water/textures/sand-normal.jpg')
    sand.repeat.set(160, 160); normal.repeat.set(160, 160)
    const material = new THREE.MeshStandardMaterial({ map: sand, normalMap: normal, color: '#bac8ad', roughness: 0.95, normalScale: new THREE.Vector2(0.45, 0.45) })
    this.underwaterLight.applyTo(material)
    const seabed = new THREE.Mesh(geometry, material)
    seabed.receiveShadow = true
    this.scene.add(seabed)
  }

  /** 鲨鱼模型没有贴图、材质是纯白金属，直接放进水里会像一团反光塑料。
   * 这里按局部高度刷一层顶点色：背部灰蓝、腹部乳白，眼睛和牙齿单独上色。 */
  private shadeShark(model: THREE.Object3D) {
    const back = new THREE.Color('#39474f')
    const belly = new THREE.Color('#c8d2d3')
    const tint = new THREE.Color()
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      const material = object.material as THREE.MeshStandardMaterial
      material.metalness = 0
      material.roughness = 0.5
      material.envMapIntensity = 0.45
      if (object.name === 'Eyes') {
        material.color.set('#0b1214')
        material.roughness = 0.25
        return
      }
      if (object.name === 'Teeth') {
        material.color.set('#f0f3f0')
        material.roughness = 0.35
        return
      }
      const position = object.geometry.getAttribute('position')
      const colors = new Float32Array(position.count * 3)
      for (let i = 0; i < position.count; i++) {
        tint.copy(belly).lerp(back, THREE.MathUtils.smoothstep(position.getY(i), -1.1, 0.9))
        colors[i * 3] = tint.r
        colors[i * 3 + 1] = tint.g
        colors[i * 3 + 2] = tint.b
      }
      object.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      material.vertexColors = true
      material.color.set('#ffffff')
      material.needsUpdate = true
      // 只有身体需要变形；眼睛和牙齿都长在头部附近，摆幅接近零，跟随即可。
      this.addSwimDeformation(object)
    })
  }

  private addSwimDeformation(mesh: THREE.Mesh) {
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    if (box) {
      this.sharkSwim.uSwimHead.value = box.min.x
      this.sharkSwim.uSwimLength.value = Math.max(box.max.x - box.min.x, 0.001)
    }
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.patchSwim(material)
    // 阴影用的是独立深度材质，不注入就只剩原地不动的影子。
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    this.patchSwim(depth)
    mesh.customDepthMaterial = depth
  }

  /** 包一层 onBeforeCompile，避免覆盖水下光照已经挂上的着色器改动。 */
  private patchSwim(material: THREE.Material) {
    const previous = material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      Object.assign(shader.uniforms, this.sharkSwim)
      shader.vertexShader = sharkSwimUniforms + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>${sharkSwimWave}`)
    }
    material.customProgramCacheKey = () => 'shark-swim'
    material.needsUpdate = true
  }

  private normalizeModel(model: THREE.Object3D, length: number, draft: number) {
    let box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    model.scale.multiplyScalar(length / Math.max(size.x, size.z))
    model.updateMatrixWorld(true)
    box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    model.position.x -= center.x
    model.position.z -= center.z
    model.position.y -= box.min.y + draft
    model.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true
        object.receiveShadow = true
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) this.underwaterLight.applyTo(material)
      }
    })
    return model
  }

  /** 把一条沉船摆到海床上：先按给定姿态旋转，再让旋转后的最低点沉进沙里指定深度。 */
  private placeWreck(model: THREE.Object3D, options: { length: number; x: number; z: number; yaw: number; pitch: number; roll: number; sink: number }) {
    const hull = this.normalizeModel(model, options.length, 0)
    hull.visible = true
    const wreck = new THREE.Group()
    wreck.add(hull)
    this.scene.add(wreck)
    wreck.rotation.set(options.pitch, options.yaw, options.roll)
    wreck.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(wreck)
    const center = box.getCenter(new THREE.Vector3())
    const reach = options.length * 0.75
    // 海床是缓慢起伏的曲面，取船体覆盖范围内最低的点，免得一头悬空。
    const floor = Math.min(
      this.seabedHeight(options.x, options.z),
      this.seabedHeight(options.x + reach, options.z),
      this.seabedHeight(options.x - reach, options.z),
      this.seabedHeight(options.x, options.z + reach),
      this.seabedHeight(options.x, options.z - reach)
    )
    wreck.position.set(options.x - center.x, floor - box.min.y - options.sink, options.z - center.z)
    this.wrecks.push(wreck)
    return wreck
  }

  private async loadModels() {
    this.draco.setDecoderPath('/jsm/draco/gltf/')
    const loader = new GLTFLoader().setDRACOLoader(this.draco)
    // 以斜杠开头的名字视为仓库内的完整路径（鲨鱼与沉船模型不在 /water/models 下）。
    const files = ['dutch_ship_medium_2k', 'island', 'buoy', 'rocks', 'seaweed', 'grass', 'fish', '/jsm/draco/gltf/Shark.glb', '/jsm/draco/gltf/chenchuan.glb', '/jsm/draco/gltf/chenchuan2.glb']
    const labels = ['木帆船', '沙滩海岛', '航道浮标', '海底礁石', '海藻', '海草', '鱼群', '鲨鱼', '海底沉船', '二号沉船']
    let count = 0
    try {
      const [results] = await Promise.all([Promise.all(files.map(async (name, index) => {
        const gltf = await loader.loadAsync(name.startsWith('/') ? name : `/water/models/${name}.glb`)
        if (this.disposed) { disposeTree(gltf.scene); return null }
        // 任何已解析的模型都要纳入管理，即使另一次请求失败或视图卸载。
        gltf.scene.visible = false
        this.scene.add(gltf.scene)
        this.callbacks.progress(Math.round(++count / (files.length + 1) * 100), `${labels[index]}已就绪`)
        return gltf
      })), this.atmosphere.ready.then(() => {
        if (!this.disposed) this.callbacks.progress(Math.round(++count / (files.length + 1) * 100), '体积云与大气已就绪')
      })])
      if (this.disposed) return
      const [shipGLTF, islandGLTF, buoyGLTF, rocksGLTF, seaweedGLTF, grassGLTF, fishGLTF, sharkGLTF, wreckGLTF, wreck2GLTF] = results
      if (!shipGLTF || !islandGLTF || !buoyGLTF || !rocksGLTF || !seaweedGLTF || !grassGLTF || !fishGLTF) return
      const shipModel = this.normalizeModel(shipGLTF.scene, 28, 1.65)
      const shipSize = new THREE.Box3().setFromObject(shipModel).getSize(new THREE.Vector3())
      if (shipSize.z > shipSize.x) shipModel.rotation.y = Math.PI / 2
      shipModel.visible = true
      this.hull.add(shipModel)

      // 参考海岛的模型是 Z 轴向上的，与 Y 轴向上的船不同。
      islandGLTF.scene.rotation.x = -Math.PI / 2
      const island = this.normalizeModel(islandGLTF.scene, 66, 0)
      // 它的沙质基座远低于岸线。要对齐的是作者设定的岸线，
      // 而不是把基座底部抬到水面。
      island.position.y = 2.25
      island.position.add(new THREE.Vector3(-25, 0, -48))
      island.visible = true
      // 船体与海岛都会沾上与海冰一样的风吹积雪。
      this.snowCover.add(this.hull)
      this.snowCover.add(island)

      const buoy = this.normalizeModel(buoyGLTF.scene, 0.35, 0.18)
      for (let i = 0; i < 8; i++) {
        const group = new THREE.Group()
        const model = buoy.clone(true)
        model.visible = true
        group.add(model)
        group.position.set(-45 + i * 13, 0, i % 2 ? -20 : 20)
        this.scene.add(group)
        this.buoys.push(group)
      }

      let seed = 8437
      const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
      for (const [source, length, amount] of [[rocksGLTF.scene, 5, 24], [seaweedGLTF.scene, 2, 42], [grassGLTF.scene, 2.6, 54]] as const) {
        this.normalizeModel(source, length, 0)
        for (let i = 0; i < amount; i++) {
          const model = source.clone(true)
          const x = (random() - 0.5) * 175, z = (random() - 0.5) * 145
          model.visible = true
          model.position.add(new THREE.Vector3(x, this.seabedHeight(x, z) - 0.1, z))
          model.rotation.y = random() * Math.PI * 2
          model.scale.multiplyScalar(0.6 + random() * 1.1)
          this.scene.add(model)
        }
      }
      const fishModel = this.normalizeModel(fishGLTF.scene, 0.8, 0)
      for (let i = 0; i < 16; i++) {
        const model = clone(fishModel)
        model.visible = true
        this.scene.add(model)
        this.fish.push(model)
        if (fishGLTF.animations.length) {
          const mixer = new THREE.AnimationMixer(model)
          mixer.clipAction(fishGLTF.animations[0]).play()
          this.mixers.push(mixer)
        }
      }
      // 鲨鱼：模型体长沿 -X，头在 -X 端（眼睛节点在 x≈-4.3），
      // 所以绕 Y 转 -90° 把头调到 -Z，再用组的角度控制朝向。
      if (sharkGLTF) {
        const sharkModel = this.normalizeModel(sharkGLTF.scene, 6, 0)
        this.shadeShark(sharkModel)
        const size = new THREE.Box3().setFromObject(sharkModel).getSize(new THREE.Vector3())
        // normalizeModel 把腹面贴到 y=0，这里改为让身体中心落在组的原点。
        sharkModel.position.y -= size.y * 0.5
        sharkModel.rotation.y = -Math.PI / 2
        sharkModel.visible = true
        const shark = new THREE.Group()
        shark.add(sharkModel)
        this.scene.add(shark)
        this.shark = shark

        // 巡游航线：绕海岛一圈，但半径刻意忽远忽近，不是同心圆。
        // 控制点写死（不随机），每次加载都是同一条闭合曲线，鲨鱼沿它缓慢变速游动。
        // 半径在 70~108 之间来回摆动：最近处贴到海岛外围，最远处游到外圈。
        const radii = [96, 84, 76, 90, 108, 98, 80, 70, 84, 96, 106, 92, 78, 72, 88, 102]
        const route = radii.map((radius, index) => {
          const angle = index / radii.length * Math.PI * 2
          return new THREE.Vector3(this.iceCenter.x + Math.cos(angle) * radius, 0, this.iceCenter.y + Math.sin(angle) * radius)
        })
        this.sharkPath = new THREE.CatmullRomCurve3(route, true, 'catmullrom', 0.5)
        this.sharkPathLength = this.sharkPath.getLength()
        this.sharkProgress = 0
      }
      // 沉船：模型的长轴是 Z，绕 Z 旋转就是侧倾，绕 X 旋转是船头翘起。
      if (wreckGLTF) {
        // 一号：侧翻约 29°，大半船身陷进沙里。
        this.placeWreck(wreckGLTF.scene, { length: 16, x: -110, z: 55, yaw: 2.1, pitch: 0.1, roll: -0.5, sink: 2.7 })
      }
      if (wreck2GLTF) {
        // 二号：只是浅浅搁在海床上，倾斜和下沉都收着来。
        this.placeWreck(wreck2GLTF.scene, { length: 14, x: 105, z: -75, yaw: 0.8, pitch: 0.07, roll: -0.28, sink: 1.1 })
      }
      this.updateWeatherLighting()
      this.updateEnvironment()
      this.startIntro()
      this.callbacks.ready()
    } catch (error) {
      if (!this.disposed) this.callbacks.error(`场景资源加载失败，请重试。${error instanceof Error ? error.message : ''}`)
    }
  }

  private createProbes() {
    const geometry = new THREE.SphereGeometry(0.22, 10, 8)
    const material = new THREE.MeshBasicMaterial({ color: '#7cffe6', depthTest: false })
    for (const x of [-9, 0, 9]) for (const z of [-2.4, 2.4]) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.userData.offset = new THREE.Vector2(x, z)
      mesh.renderOrder = 20
      this.probes.add(mesh)
    }
    const wakeMaterial = new THREE.MeshBasicMaterial({ color: '#ffc96b', wireframe: true, depthTest: false })
    const ring = new THREE.TorusGeometry(0.5, 0.08, 4, 16)
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(ring, wakeMaterial)
      mesh.rotation.x = -Math.PI / 2
      mesh.renderOrder = 20
      this.wakeProbes.add(mesh)
    }
  }

  applySettings(next: WaterSettings) {
    const previous = this.settings
    this.settings = { ...next }
    const preset = presets[next.preset as keyof typeof presets] ?? presets['Three.js Sky Pro']
    this.material.uniforms.uWind.value = next.wind
    this.spectrum.configure(next.wind, next.wavelength, next.quality)
    this.atmosphere.configure(next.quality)
    this.atmosphere.setWeather(next.skyExposure * (1 - next.overcast * 0.3), next.haze)
    this.atmosphere.setOvercast(next.overcast)
    this.rainSystem.setQuality(next.quality)
    this.rainSystem.setIntensity(next.rain)
    this.rainSystem.setWind(next.wind)
    this.snowSystem.setQuality(next.quality)
    this.snowSystem.setIntensity(next.snow)
    this.material.uniforms.uRain.value = next.rain
    this.material.uniforms.uOvercast.value = next.overcast
    this.material.uniforms.uWaterColor.value.set(preset.water).lerp(overcastWater, next.overcast * 0.65)
    this.probes.visible = next.buoyancyProbes
    this.wakeProbes.visible = next.wakeProbes
    if (previous.dayOfYear !== next.dayOfYear || previous.timeOfDay !== next.timeOfDay) {
      this.weather.setDate(next.dayOfYear, next.timeOfDay)
    }
    this.updateWeatherLighting()
    this.callbacks.weather?.(this.weather.snapshot())
    if (previous.quality !== next.quality) {
      this.environment?.dispose()
      this.environment = null
      this.ocean.geometry.dispose()
      this.ocean.geometry = this.waterGeometry(next.quality)
      const size = qualityOptions[next.quality].reflection
      this.ocean.getRenderTarget().setSize(size, size)
    }
    if (previous.quality !== next.quality || previous.pixelRatio !== next.pixelRatio || this.width === 1) this.resize()
    if (!this.environment || previous.quality !== next.quality || previous.timeOfDay !== next.timeOfDay || previous.dayOfYear !== next.dayOfYear || previous.skyExposure !== next.skyExposure || previous.haze !== next.haze || previous.clouds !== next.clouds || previous.overcast !== next.overcast || previous.preset !== next.preset) {
      clearTimeout(this.environmentTimer)
      this.environmentTimer = setTimeout(() => this.updateEnvironment(), 200)
    }
  }

  private updateWeatherLighting(immediate = true) {
    const sun = this.weather.sunDirection
    const altitude = sun.y
    const daylight = THREE.MathUtils.smoothstep(altitude, -0.12, 0.22)
    const sunset = (1 - THREE.MathUtils.smoothstep(Math.abs(altitude), 0.02, 0.45)) * daylight
    const { overcast, rain } = this.settings
    // 阴天是加厚云层，而不是替换天气预设。
    const coverage = THREE.MathUtils.clamp(this.settings.clouds + overcast * 0.55, 0, 1)
    this.atmosphere.setLighting(sun, coverage, daylight, { moon: this.weather.moonDirection, immediate })
    this.sun.position.copy(sun).multiplyScalar(170)
    this.atmosphere.sunLightColor(this.sun.color)
    const strength = Math.max(this.sun.color.r, this.sun.color.g, this.sun.color.b)
    if (strength > 0) this.sun.color.multiplyScalar(1 / strength)
    const transmission = Math.min(strength, 1) * THREE.MathUtils.smoothstep(altitude, -0.01, 0.03)
    this.sun.intensity = 3.8 * transmission * (1 - coverage * 0.42) * (1 - overcast * 0.62)
    this.sun.castShadow = altitude > 0 && overcast < 0.55
    this.ambient.intensity = (0.45 + daylight * 1.23) * (1 + overcast * 0.55)
    this.fill.intensity = (0.25 + daylight * 3.25) * (1 - coverage * 0.3) * (1 - overcast * 0.5)
    this.ambient.color.set(daylight > 0.3 ? '#b7d7ed' : '#507299').lerp(overcastAmbient, overcast * 0.85)
    this.material.uniforms.uSun.value.copy(sun)
    this.material.uniforms.uSunColor.value.copy(this.sun.color).multiplyScalar(transmission * (1 - overcast * 0.55))
    this.material.uniforms.uDaylight.value = daylight * (1 - overcast * 0.45)
    const preset = presets[this.settings.preset as keyof typeof presets] ?? presets['Three.js Sky Pro']
    const fogScale = 1 + overcast * 1.5 + rain * 1.9
    this.material.uniforms.uFog.value = preset.fog * fogScale
    const fogColor = this.material.uniforms.uFogColor.value as THREE.Color
    fogColor.setRGB(0.2, 0.26, 0.33).multiplyScalar(0.035 + daylight * 0.965)
    fogColor.lerp(new THREE.Color('#d79873'), sunset * 0.26)
    fogColor.lerp(overcastFog, overcast * 0.8)
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(fogColor, preset.fog)
  }

  getWeather(): WeatherSnapshot { return this.weather.snapshot() }

  setWeatherDate(dayOfYear: number, timeOfDay: number) {
    this.weather.setDate(dayOfYear, timeOfDay)
    this.settings.dayOfYear = this.weather.dayOfYear
    this.settings.timeOfDay = this.weather.timeOfDay
    this.updateWeatherLighting()
    this.callbacks.weather?.(this.weather.snapshot())
    clearTimeout(this.environmentTimer)
    this.environmentTimer = setTimeout(() => this.updateEnvironment(), 150)
  }

  private updateEnvironment(refreshSky = true) {
    if (this.disposed || !this.atmosphere.isReady) return
    if (refreshSky) this.atmosphere.update(this.weather.cloudTime, true, this.time)
    this.environmentGenerator ??= new THREE.PMREMGenerator(this.renderer)
    this.environment = this.environmentGenerator.fromCubemap(this.atmosphere.texture, this.environment)
    this.scene.environment = this.environment.texture
    this.lastEnvironmentUpdate = this.time
  }

  setMode(mode: CameraMode) {
    this.mode = mode
    this.keys.clear()
    // 开场镜头还在播的时候只记住模式，别把相机从云层里拽下来。
    if (this.intro.active) return
    this.controls.enablePan = mode === 'orbit'
    this.controls.minDistance = mode === 'fly' ? 0.1 : 3
    if (mode === 'fly') {
      const direction = this.camera.getWorldDirection(new THREE.Vector3())
      this.controls.target.copy(this.camera.position).addScaledVector(direction, 3)
    }
    if (mode === 'orbit') {
      this.controls.target.copy(this.ship.position).add(new THREE.Vector3(0, 5, 0))
    }
    if (mode === 'boat') {
      this.controls.target.copy(this.ship.position).add(new THREE.Vector3(0, 5, 0))
      this.camera.position.copy(this.ship.position).add(new THREE.Vector3(-34, 16, 30))
    }
    this.controls.update()
  }

  /** 开场：镜头先悬在船正上方的云层里漂一会儿，再穿过云底落回海面。 */
  startIntro() {
    const ship = this.ship.position
    this.intro.active = true
    this.intro.elapsed = 0
    this.camera.position.set(ship.x, MAX_CAMERA_DISTANCE, ship.z + 26)
    this.controls.target.copy(ship)
    this.controls.enabled = false
  }

  private stopIntro() {
    if (!this.intro.active) return
    this.intro.active = false
    this.controls.enabled = true
  }

  private updateIntro(delta: number) {
    const intro = this.intro
    intro.elapsed += delta
    const { x, z } = this.ship.position
    // 云里的漂移：水平缓慢横移、高度轻轻起伏，幅度几十米，像悬停在云团中间。
    const sway = Math.sin(intro.elapsed * 0.7) * 22
    const lift = Math.sin(intro.elapsed * 0.9) * 26
    const progress = THREE.MathUtils.clamp((intro.elapsed - intro.hold) / intro.descent, 0, 1)
    const fall = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
    // 前半段几乎只往下掉，后半段才把横向位置收到最终机位。
    const lateral = THREE.MathUtils.smoothstep(progress, 0.45, 1)
    this.camera.position.set(
      THREE.MathUtils.lerp(x + sway, 17, lateral),
      THREE.MathUtils.lerp(MAX_CAMERA_DISTANCE + lift, 11, fall),
      THREE.MathUtils.lerp(z + 26 + sway * 0.4, 37, lateral)
    )
    // 一路盯着船，快到海面时再过渡到默认构图。
    const aim = THREE.MathUtils.smoothstep(progress, 0.55, 1)
    this.controls.target.set(
      THREE.MathUtils.lerp(x, -4, aim),
      THREE.MathUtils.lerp(this.ship.position.y, 6, aim),
      THREE.MathUtils.lerp(z, -3, aim)
    )
    // 开场期间不能走 controls.update()（它会把相机拽回 maxDistance 以内），朝向我们自己算。
    this.camera.lookAt(this.controls.target)
    if (progress >= 1) {
      this.stopIntro()
      this.controls.update()
    }
  }

  resetCamera() {
    this.stopIntro()
    this.ship.position.set(0, 0, 4)
    this.heading = -0.12
    this.speed = 0
    this.setMode('orbit')
    this.camera.position.set(17, 11, 37)
    this.controls.target.set(-4, 6, -3)
    this.controls.update()
  }

  underwaterView() {
    this.stopIntro()
    this.setMode('fly')
    this.camera.position.set(18, -3.4, 25)
    const direction = new THREE.Vector3(0, -4.6, -15).sub(this.camera.position).normalize()
    this.controls.target.copy(this.camera.position).addScaledVector(direction, 3)
    this.controls.update()
  }

  /** 把镜头送到指定沉船斜上方并朝向它，不动当前的视角模式。模型还没加载完时返回 false。 */
  focusWreck(index = 0) {
    const wreck = this.wrecks[index]
    if (!wreck) return false
    const center = wreck.position
    this.flyTo(
      new THREE.Vector3(center.x + 10, center.y + 7, center.z + 18),
      new THREE.Vector3(center.x, center.y + 2, center.z)
    )
    return true
  }

  /** 从当前位置平滑飞到目标机位，而不是瞬移。 */
  private flyTo(position: THREE.Vector3, target: THREE.Vector3) {
    this.stopIntro()
    const distance = this.camera.position.distanceTo(position)
    this.flight.fromPosition.copy(this.camera.position)
    this.flight.fromTarget.copy(this.controls.target)
    this.flight.toPosition.copy(position)
    this.flight.toTarget.copy(target)
    // 二次贝塞尔的中点抬高一些，长距离飞行时不会贴着海面或擦着海床过去。
    this.flight.midPosition.copy(position).add(this.camera.position).multiplyScalar(0.5)
    this.flight.midPosition.y += Math.max(6, distance * 0.18)
    this.flight.elapsed = 0
    this.flight.duration = THREE.MathUtils.clamp(distance / 90, 0.9, 2.4)
    this.flight.active = true
    // 飞行途中先接管鼠标，免得手一抖把机位带偏。
    this.controls.enabled = false
  }

  private updateCameraFlight(delta: number) {
    const flight = this.flight
    if (!flight.active) return
    flight.elapsed += delta
    const progress = Math.min(flight.elapsed / flight.duration, 1)
    // 缓入缓出，起落都不会有突然的加速感。
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
    const inverse = 1 - eased
    this.camera.position.copy(flight.fromPosition).multiplyScalar(inverse * inverse)
      .addScaledVector(flight.midPosition, 2 * inverse * eased)
      .addScaledVector(flight.toPosition, eased * eased)
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased)
    if (progress >= 1) {
      flight.active = false
      this.controls.enabled = true
    }
  }

  async fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await this.host.parentElement?.requestFullscreen()
  }

  screenshot() {
    this.render()
    this.renderer.domElement.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `ocean-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  private resize() {
    if (this.disposed || !this.renderer) return
    this.width = Math.max(this.host.clientWidth, 1)
    this.height = Math.max(this.host.clientHeight, 1)
    this.renderer.setPixelRatio(Math.min(this.settings.pixelRatio, 2))
    this.renderer.setSize(this.width, this.height)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    const dimensions = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.atmosphere?.setSize(dimensions.x, dimensions.y)
    this.underwaterLight.setSize(dimensions.x, dimensions.y, this.settings.quality)
    this.material?.uniforms.uResolution.value.copy(dimensions)
    const scale = qualityOptions[this.settings.quality].refraction
    this.refraction.setSize(Math.round(dimensions.x * scale), Math.round(dimensions.y * scale))
  }

  private updateMovement(delta: number) {
    const forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'))
    const sideways = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'))
    if (this.mode === 'fly') {
      const direction = this.camera.getWorldDirection(new THREE.Vector3())
      const right = new THREE.Vector3().crossVectors(direction, this.camera.up).normalize()
      const motion = direction.multiplyScalar(forward).addScaledVector(right, sideways)
      motion.y += Number(this.keys.has('KeyE')) - Number(this.keys.has('KeyQ'))
      motion.multiplyScalar(delta * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 45 : 15))
      this.camera.position.add(motion)
      this.controls.target.add(motion)
      const floor = this.seabedHeight(this.camera.position.x, this.camera.position.z) + 0.65
      if (this.camera.position.y < floor) {
        this.controls.target.y += floor - this.camera.position.y
        this.camera.position.y = floor
      }
    }
    if (this.mode === 'boat' && !this.settings.paused) {
      this.speed = THREE.MathUtils.damp(this.speed, forward * 7.5, 0.8, delta)
      this.heading -= sideways * delta * 0.42
      const movement = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)).multiplyScalar(this.speed * delta)
      const candidate = this.ship.position.clone().add(movement)
      // 让船保持在海外，同时处在高精度水面区块内。
      if (Math.hypot(candidate.x + 25, candidate.z + 48) > 31 && Math.hypot(candidate.x, candidate.z) < 210) {
        this.ship.position.add(movement)
        this.camera.position.add(movement)
        this.controls.target.add(movement)
      } else this.speed = 0
    } else this.speed = THREE.MathUtils.damp(this.speed, 0, 2, delta)
  }

  private frame = (now: number) => {
    if (this.disposed) return
    this.animation = requestAnimationFrame(this.frame)
    if (document.hidden) { this.lastFrame = 0; return }
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 1 / 60
    this.lastFrame = now
    // 开场镜头和机位飞行期间接管相机，避免几套逻辑抢位置。
    if (this.intro.active) this.updateIntro(delta)
    else {
      if (this.flight.active) this.updateCameraFlight(delta)
      else this.updateMovement(delta)
      this.controls.update()
    }
    if (!this.settings.paused) this.time += delta
    if (this.weather.advance(delta, this.settings)) this.updateWeatherLighting(false)
    const { wind } = this.settings
    const heightAt = (x: number, z: number) => this.spectrum.heightAt(x, z, this.time)
    const { x, z } = this.ship.position
    // 冻结的水面是静止的，冰面抵达后船体便停止起伏。
    const hullFrozen = 1 - this.iceCoverAt(x, z)
    this.ship.position.y = heightAt(x, z) * 0.78 * hullFrozen
    this.ship.rotation.y = this.heading
    this.hull.rotation.x = -(heightAt(x, z + 3) - heightAt(x, z - 3)) / 6 * 0.65 * hullFrozen
    this.hull.rotation.z = (heightAt(x + 8, z) - heightAt(x - 8, z)) / 16 * 0.65 * hullFrozen
    this.buoys.forEach((buoy, index) => {
      const free = 1 - this.iceCoverAt(buoy.position.x, buoy.position.z)
      buoy.position.y = heightAt(buoy.position.x, buoy.position.z) * free
      buoy.rotation.z = Math.sin(this.time * 1.2 + index) * wind * 0.004 * free
      buoy.rotation.x = Math.cos(this.time * 0.9 + index) * wind * 0.003 * free
    })
    this.fish.forEach((fish, index) => {
      const phase = this.time * 0.12 + index * 0.6
      fish.position.set(Math.cos(phase) * (13 + index * 0.9), -3.9 + Math.sin(phase * 2 + index) * 0.7, Math.sin(phase) * 18 + 3)
      fish.rotation.y = -phase
    })
    if (this.shark && this.sharkPath) {
      // 沿不规则的闭合航线巡游：有时贴着海岛外围转，有时绕到很远的外圈。
      if (!this.settings.paused) {
        const speed = 4.6 + Math.sin(this.time * 0.11) * 0.9
        this.sharkProgress = (this.sharkProgress + delta * speed / this.sharkPathLength) % 1
      }
      const point = this.sharkPath.getPointAt(this.sharkProgress, this.sharkPoint)
      const tangent = this.sharkPath.getTangentAt(this.sharkProgress, this.sharkTangent)
      // 模型背鳍尖端在身体中心上方约 1.25 m。深度跟着当地波面走，
      // 身体压在浪面下 2.1 m 上下浮动，起伏到最高点仍留 0.45 m，鳍尖全程不破水。
      const depth = -2.1 + Math.sin(this.time * 0.19) * 0.4
      this.shark.position.set(point.x, heightAt(point.x, point.z) + depth, point.z)
      this.sharkSwim.uSwimTime.value = this.time
      // 航线切线就是游动方向；模型头朝 -Z，所以用 atan2(-dx, -dz)。
      const yaw = Math.atan2(-tangent.x, -tangent.z)
      // 摆尾时头部会带一点同频的反向偏摆，幅度很小，只用来消掉头部的僵硬感。
      this.shark.rotation.y = yaw + Math.sin(this.time * 3.4) * 0.018
      // 上浮时抬头、下沉时低头。
      this.shark.rotation.x = Math.cos(this.time * 0.19) * 0.03
      // 侧倾跟着转弯方向走：航线往左拐就左压，往右拐就右压，不再是固定值。
      const turn = Math.atan2(Math.sin(yaw - this.sharkYaw), Math.cos(yaw - this.sharkYaw))
      this.sharkYaw = yaw
      const bank = THREE.MathUtils.clamp(turn / Math.max(delta, 1e-4) * 0.9, -0.16, 0.16)
      this.sharkRoll = THREE.MathUtils.damp(this.sharkRoll, bank, 1.5, delta)
      this.shark.rotation.z = this.sharkRoll
    }
    if (!this.settings.paused) this.mixers.forEach(mixer => mixer.update(delta))
    this.probes.children.forEach(probe => {
      const offset = probe.userData.offset as THREE.Vector2
      const px = x + offset.x * Math.cos(this.heading) + offset.y * Math.sin(this.heading)
      const pz = z - offset.x * Math.sin(this.heading) + offset.y * Math.cos(this.heading)
      probe.position.set(px, heightAt(px, pz) + 0.3, pz)
    })
    this.wakeProbes.children.forEach((probe, index) => {
      const distance = 10 + Math.floor(index / 2) * 5
      const spread = (index % 2 ? 1 : -1) * distance * 0.17
      const px = x - distance * Math.cos(this.heading) + spread * Math.sin(this.heading)
      const pz = z + distance * Math.sin(this.heading) + spread * Math.cos(this.heading)
      probe.position.set(px, heightAt(px, pz) + 0.12, pz)
    })
    this.material.uniforms.uTime.value = this.time
    this.material.uniforms.uEye.value.copy(this.camera.position)
    this.material.uniforms.uBoat.value.set(x, this.heading, z)
    this.material.uniforms.uBoatSpeed.value = Math.abs(this.speed)
    this.atmosphere.update(this.weather.cloudTime, false, this.time)
    // 直射阳光每帧更新；IBL 变化较慢，复用 PMREM 目标。
    if (!this.settings.paused && (this.settings.animateTime || this.settings.animateClouds) && this.time - this.lastEnvironmentUpdate >= 0.5) {
      this.updateEnvironment(false)
    }
    this.spectrum.update(this.time, this.material.uniforms)
    this.underwaterLight.update(this.renderer, this.time, this.weather.sunDirection, this.sun.color, this.material.uniforms.uDaylight.value, this.sun.intensity / 3.8)
    this.waterLevel = heightAt(this.camera.position.x, this.camera.position.z)
    const underwater = this.camera.position.y < this.waterLevel - 0.1
    this.underwater = underwater
    const preset = presets[this.settings.preset as keyof typeof presets] ?? presets['Three.js Sky Pro']
    const fog = this.scene.fog as THREE.FogExp2
    // 水下消光在光学通道里按深度处理，不作为场景雾重复叠加。
    const weatherFog = preset.fog * (1 + this.settings.overcast * 1.5 + this.settings.rain * 1.9)
    fog.density = underwater ? 0 : weatherFog
    fog.color.copy(underwater ? new THREE.Color('#064052') : this.material.uniforms.uFogColor.value)
    this.sky.material.uniforms.uUnderwater.value = underwater ? 1 : 0
    const flash = this.lightning.update(delta, this.settings.lightning, this.settings.overcast, this.settings.rain, this.camera)
    this.flashLight.position.copy(this.camera.position).addScaledVector(this.lightning.strikeDirection, 420)
    this.flashLight.intensity = flash * 11
    this.atmosphere.setFlash(flash, this.lightning.strikeDirection)
    this.material.uniforms.uFlash.value = flash
    this.rainSystem.update(this.time, this.camera, this.material.uniforms.uDaylight.value)
    // 雨滴只存在于空气一侧。
    this.rainSystem.mesh.visible = !underwater && this.settings.rain > 0.004
    // 冰面从海岛向外以匀速推进，速度按“整个 220 m 行程用二十秒”标定。
    // 这里用按距离换算的匀速，而不是指数阻尼：那样 32% -> 40% 会和
    // 0% -> 100% 花掉同样长的时间常数，只有这点距离却要等十几秒。
    const iceTarget = this.settings.freeze * 220
    const iceStep = (220 / 20) * delta
    const iceGap = iceTarget - this.iceRadius
    this.iceRadius = Math.abs(iceGap) <= iceStep ? iceTarget : this.iceRadius + Math.sign(iceGap) * iceStep
    this.material.uniforms.uIceRadius.value = this.iceRadius
    this.snowAmount = THREE.MathUtils.damp(this.snowAmount, this.settings.snow > 0.02 ? Math.min(1, this.settings.snow * 1.15) : 0, 0.16, delta)
    this.snowCover.amount = this.snowAmount
    this.snowSystem.update(this.time, this.camera, this.material.uniforms.uDaylight.value)
    this.snowSystem.mesh.visible = !underwater && this.settings.snow > 0.004
    this.render()
    if (now - this.lastWeatherStats >= 100) {
      this.callbacks.weather?.(this.weather.snapshot())
      this.lastWeatherStats = now
    }
    this.frameCount++
    if (now - this.lastStats > 700) {
      this.callbacks.stats(Math.round(this.frameCount * 1000 / (now - this.lastStats)), underwater, Math.abs(this.speed) * 1.94384)
      this.frameCount = 0
      this.lastStats = now
    }
  }

  private render() {
    this.ocean.visible = false
    // 折射缓冲必须保留透过斯涅尔窗看到的空气侧天空。
    this.sky.material.uniforms.uUnderwater.value = 0
    // 拖尾属于空气中的雨，不能渗进折射的水体里。
    const rainVisible = this.rainSystem.mesh.visible
    const snowVisible = this.snowSystem.mesh.visible
    this.rainSystem.mesh.visible = false
    this.snowSystem.mesh.visible = false
    this.renderer.setRenderTarget(this.refraction)
    this.renderer.render(this.scene, this.camera)
    this.rainSystem.mesh.visible = rainVisible
    this.snowSystem.mesh.visible = snowVisible
    this.ocean.visible = true
    this.sky.material.uniforms.uUnderwater.value = this.underwater ? 1 : 0
    this.renderer.setRenderTarget(this.underwater ? this.underwaterLight.target : null)
    this.renderer.render(this.scene, this.camera)
    if (this.underwater) this.underwaterLight.render(this.renderer, this.camera, this.sun, this.waterLevel)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.animation)
    clearTimeout(this.environmentTimer)
    this.events.abort()
    this.observer.disconnect()
    this.controls.dispose()
    this.keys.clear()
    this.mixers.forEach(mixer => { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()) })
    this.draco.dispose()
    this.spectrum.dispose()
    this.atmosphere.dispose()
    this.underwaterLight.dispose()
    this.rainSystem.dispose()
    this.lightning.dispose()
    this.snowSystem.dispose()
    this.iceMaps?.cracks.dispose()
    this.iceMaps?.perlin.dispose()
    disposeTree(this.scene)
    this.textures.forEach(texture => texture.dispose())
    this.environment?.dispose()
    this.environmentGenerator?.dispose()
    this.ocean.getRenderTarget().depthTexture?.dispose()
    this.ocean.dispose()
    this.refraction.dispose()
    this.refraction.depthTexture?.dispose()
    this.sun.shadow.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
