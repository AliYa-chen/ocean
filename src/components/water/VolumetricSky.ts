import * as THREE from 'three'
import { EffectPass } from 'postprocessing'
import { AerialPerspectiveEffect, PrecomputedTexturesLoader, getSunLightColor, type PrecomputedTextures } from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'
import { DataTextureLoader, parseUint8Array, STBNLoader } from '@takram/three-geospatial'
import type { Quality } from './settings'
import { weatherOrigin, worldToECEF } from './weather'

const ASSETS = '/water/takram'
const qualityOptions: Record<Quality, { screenScale: number; reflection: number }> = {
  Low: { screenScale: 0.65, reflection: 128 },
  Medium: { screenScale: 0.85, reflection: 192 },
  High: { screenScale: 1, reflection: 256 },
  Ultra: { screenScale: 1, reflection: 384 },
}

const fullscreenVertex = /* glsl */ `
  varying vec2 vSkyUV;
  void main() {
    vSkyUV = uv;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`
// 与示例的曝光 10 对齐，同时保留海洋现有的最终色调映射。
// 立方体存的是线性 HDR，绝不能存已经做过色调映射的图像。
const skyRadiance = /* glsl */ `
  vec3 skyRadiance(vec3 radiance, float daylight, float exposure) {
    return radiance * exposure + vec3(0.002, 0.004, 0.009) * (1.0 - daylight);
  }
`
// 厚重的阴天既降低天空饱和度又压暗它，与海洋着色器通过 uOvercast
// 施加的那种平坦掠射光保持一致。
const overcastTint = /* glsl */ `
  vec3 overcastTint(vec3 color, float overcast) {
    float grey = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(color, vec3(grey) * vec3(0.76, 0.81, 0.9), overcast * 0.85)
      * (1.0 - overcast * 0.32);
  }
`

interface CloudTextures {
  atmosphere: PrecomputedTextures
  weather: THREE.Texture
  shape: THREE.Data3DTexture
  detail: THREE.Data3DTexture
  turbulence: THREE.Texture
  noise: THREE.Data3DTexture
}

/** 官方 Clouds -> AerialPerspective 合成，离屏渲染，线性 HDR。
 * 直接使用 EffectPass 可以避免改变海洋画布尺寸或 autoClear，
 * 而多引入一个 EffectComposer 恰恰会为反射通道去动它们。
 */
class SkyPass {
  readonly clouds: CloudsEffect
  readonly atmosphere: AerialPerspectiveEffect
  private readonly pass: EffectPass
  private readonly input = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
  readonly output = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })

  constructor(camera: THREE.Camera) {
    this.clouds = new CloudsEffect(camera)
    this.atmosphere = new AerialPerspectiveEffect(camera, { sky: true, sunLight: false, skyLight: false })
    this.clouds.worldToECEFMatrix.copy(worldToECEF)
    this.atmosphere.worldToECEFMatrix.copy(worldToECEF)
    this.clouds.events.addEventListener('change', () => {
      this.atmosphere.overlay = this.clouds.atmosphereOverlay
      this.atmosphere.shadowLength = this.clouds.atmosphereShadowLength
    })
    this.input.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
    this.pass = new EffectPass(camera, this.clouds, this.atmosphere)
    this.pass.renderToScreen = false
    this.pass.encodeOutput = false
    this.pass.fullscreenMaterial.toneMapped = false
    this.pass.setDepthTexture(this.input.depthTexture)
  }

  initialize(renderer: THREE.WebGLRenderer, textures: CloudTextures) {
    Object.assign(this.clouds, textures.atmosphere, {
      localWeatherTexture: textures.weather, shapeTexture: textures.shape,
      shapeDetailTexture: textures.detail, turbulenceTexture: textures.turbulence,
      stbnTexture: textures.noise,
    })
    Object.assign(this.atmosphere, textures.atmosphere, { stbnTexture: textures.noise })
    this.pass.initialize(renderer, false, THREE.HalfFloatType)
  }

  setSize(width: number, height: number) {
    this.input.setSize(width, height)
    this.output.setSize(width, height)
    this.pass.setSize(width, height)
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, sun: THREE.Vector3, moon: THREE.Vector3, coverage: number, time: number) {
    this.pass.mainCamera = camera
    this.clouds.sunDirection.copy(sun)
    this.atmosphere.sunDirection.copy(sun)
    this.atmosphere.moonDirection.copy(moon)
    this.clouds.coverage = coverage
    // 使用绝对模拟时间，让两个视图保持同相位，暂停/恢复也不例外。
    this.clouds.localWeatherOffset.set(time * 0.001, 0)
    this.clouds.shapeOffset.set(0, 0, 0)
    this.clouds.shapeDetailOffset.set(0, 0, 0)
    renderer.setRenderTarget(this.input)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    // 深度为空（1）时走 SDK 的天空路径。场景几何保留自己原有的
    // 光照/折射管线，不在这里被二次照明。
    this.pass.render(renderer, this.input, this.output, 0, false)
  }

  dispose() {
    this.pass.dispose()
    this.input.depthTexture?.dispose()
    this.input.dispose()
    this.output.dispose()
  }
}

export class VolumetricSky {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  readonly ready: Promise<void>
  private readonly view: SkyPass
  private readonly reflection: SkyPass
  private readonly cubeTarget = new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  })
  private readonly cubeCamera = new THREE.CubeCamera(0.1, 200000, this.cubeTarget)
  private readonly copyScene = new THREE.Scene()
  private readonly copyCamera = new THREE.Camera()
  private readonly copyMaterial: THREE.ShaderMaterial
  private readonly copyQuad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly assets = new Set<THREE.Texture>()
  private readonly sun = new THREE.Vector3()
  private readonly moon = new THREE.Vector3()
  private readonly previousCamera = new THREE.Matrix4()
  private readonly clearColor = new THREE.Color()
  private readonly viewport = new THREE.Vector4()
  private readonly scissor = new THREE.Vector4()
  private quality: Quality = 'High'
  private coverage = 0.37
  private width = 1
  private height = 1
  private loaded = false
  private disposed = false
  private dirty = true
  private lightingChanged = false
  private haze = true
  private settleFrames = 32
  private lastTime = -1
  private lastReflectionTime = -1
  private cubeSweep = 0
  private nextFace = 0

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly camera: THREE.PerspectiveCamera) {
    this.view = new SkyPass(camera)
    this.reflection = new SkyPass(camera)
    // 水体已经用 GGX 解析地积分了太阳。这个低分辨率立方体里
    // 的小太阳盘只会与它重复，并在波浪上产生闪烁。
    this.reflection.atmosphere.sun = false
    this.cubeCamera.coordinateSystem = renderer.coordinateSystem
    this.cubeCamera.updateCoordinateSystem()
    this.copyMaterial = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { uSky: { value: this.reflection.output.texture }, uDaylight: { value: 1 }, uExposure: { value: 10 }, uOvercast: { value: 0 } },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSky;
        uniform float uDaylight;
        uniform float uExposure;
        uniform float uOvercast;
        varying vec2 vSkyUV;
        ${skyRadiance}
        ${overcastTint}
        void main() { gl_FragColor = vec4(overcastTint(skyRadiance(texture2D(uSky, vSkyUV).rgb, uDaylight, uExposure), uOvercast), 1.0); }
      `,
    })
    this.copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial)
    this.copyQuad.frustumCulled = false
    this.copyScene.add(this.copyQuad)
    const material = new THREE.ShaderMaterial({
      depthWrite: false,
      uniforms: {
        uViewSky: { value: this.view.output.texture }, uEnvironment: { value: this.cubeTarget.texture },
        uInverseProjection: { value: new THREE.Matrix4() }, uInverseView: { value: new THREE.Matrix4() },
        uUseScreen: { value: true }, uDaylight: { value: 1 }, uExposure: { value: 10 }, uUnderwater: { value: 0 },
        uOvercast: { value: 0 }, uFlash: { value: 0 }, uFlashDirection: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D uViewSky;
        uniform samplerCube uEnvironment;
        uniform mat4 uInverseProjection;
        uniform mat4 uInverseView;
        uniform bool uUseScreen;
        uniform float uDaylight;
        uniform float uExposure;
        uniform float uUnderwater;
        uniform float uOvercast;
        uniform float uFlash;
        uniform vec3 uFlashDirection;
        varying vec2 vSkyUV;
        ${skyRadiance}
        ${overcastTint}
        void main() {
          vec4 view = uInverseProjection * vec4(vSkyUV * 2.0 - 1.0, 1.0, 1.0);
          vec3 direction = normalize(mat3(uInverseView) * view.xyz);
          vec3 color = uUseScreen
            ? skyRadiance(texture2D(uViewSky, vSkyUV).rgb, uDaylight, uExposure)
            : textureCube(uEnvironment, direction).rgb;
          color = overcastTint(color, uOvercast);
          // 闪电通道照亮的是它周围的云，而不是整个天顶。
          float flash = uUseScreen ? uFlash : 0.0;
          float align = max(dot(direction, normalize(uFlashDirection)), 0.0);
          float halo = pow(align, 6.0) * 0.4 + pow(align, 40.0) * 1.3;
          color += vec3(0.62, 0.71, 0.95) * halo * flash;
          color *= 1.0 + flash * 0.3;
          color = mix(color, vec3(0.006, 0.07, 0.1), uUnderwater * 0.93);
          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    })
    // 材质回调在 PMREM 克隆共享的那份材质上也会执行。
    material.onBeforeRender = (_renderer, _scene, renderCamera) => {
      material.uniforms.uUseScreen.value = renderCamera === this.camera
      material.uniforms.uInverseProjection.value.copy(renderCamera.projectionMatrixInverse)
      material.uniforms.uInverseView.value.copy(renderCamera.matrixWorld)
    }
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -10
    this.configure('High')
    this.ready = this.loadAssets()
  }

  get texture() { return this.cubeTarget.texture }
  get isReady() { return this.loaded }

  private own<T extends THREE.Texture>(texture: T): T {
    if (this.disposed) texture.dispose()
    else this.assets.add(texture)
    return texture
  }

  private async loadAssets() {
    const load2D = async (name: string) => {
      const texture = this.own(await new THREE.TextureLoader().loadAsync(`${ASSETS}/clouds/${name}`))
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.colorSpace = THREE.NoColorSpace
      texture.needsUpdate = true
      return texture
    }
    const load3D = async (name: string, size: number) => this.own(await new DataTextureLoader(
      THREE.Data3DTexture, parseUint8Array, {
        width: size, height: size, depth: size, format: THREE.RedFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping,
      },
    ).loadAsync(`${ASSETS}/clouds/${name}`))
    const precomputed = new Promise<PrecomputedTextures>((resolve, reject) => {
      const textures = new PrecomputedTexturesLoader().setType(this.renderer)
        .load(`${ASSETS}/atmosphere`, resolve, undefined, reject)
      // 立即接管加载器的占位贴图，包括部分失败的情况。
      Object.values(textures).forEach(texture => { if (texture instanceof THREE.Texture) this.own(texture) })
    })
    const [atmosphere, weather, shape, detail, turbulence, noise] = await Promise.all([
      precomputed,
      load2D('local_weather.png'), load3D('shape.bin', 128), load3D('shape_detail.bin', 32),
      load2D('turbulence.png'), new STBNLoader().loadAsync(`${ASSETS}/core/stbn.bin`).then(texture => this.own(texture)),
    ])
    if (this.disposed) return
    const textures = { atmosphere, weather, shape, detail, turbulence, noise }
    this.view.initialize(this.renderer, textures)
    this.reflection.initialize(this.renderer, textures)
    this.loaded = true
    this.dirty = true
  }

  configure(quality: Quality) {
    if (this.quality === quality && this.width > 1) return
    this.quality = quality
    this.view.clouds.qualityPreset = quality.toLowerCase() as Lowercase<Quality>
    this.view.clouds.temporalUpscale = true
    this.reflection.clouds.qualityPreset = 'medium'
    this.view.clouds.haze = this.reflection.clouds.haze = this.haze
    this.reflection.clouds.temporalUpscale = false
    // 立方体每个面的视角都不同：绝不能把一个面的时域历史
    // 混进另一个面。仅关闭上采样并不能关掉 TAA。
    this.reflection.clouds.cloudsPass.resolveMaterial.uniforms.temporalAlpha.value = 1
    this.reflection.clouds.shadow.temporalPass = false
    this.reflection.clouds.shadow.temporalJitter = false
    this.reflection.clouds.shadow.cascadeCount = 2
    this.reflection.clouds.shadow.mapSize.setScalar(256)
    const size = qualityOptions[quality].reflection
    this.reflection.setSize(size, size)
    this.cubeTarget.setSize(size, size)
    this.setSize(this.width, this.height)
  }

  setSize(width: number, height: number) {
    this.width = width
    this.height = height
    const scale = qualityOptions[this.quality].screenScale
    this.view.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
    this.dirty = true
  }

  setWeather(exposure: number, haze: boolean) {
    if (this.mesh.material.uniforms.uExposure.value !== exposure || this.haze !== haze) this.dirty = true
    this.mesh.material.uniforms.uExposure.value = this.copyMaterial.uniforms.uExposure.value = exposure
    this.haze = haze
    this.view.clouds.haze = this.reflection.clouds.haze = haze
  }

  setOvercast(value: number) {
    const overcast = THREE.MathUtils.clamp(value, 0, 1)
    const current = this.mesh.material.uniforms.uOvercast.value as number
    // 重建立方体环境开销很大，中途的细小变化直接忽略。
    if (Math.abs(current - overcast) > 0.1) this.dirty = true
    this.mesh.material.uniforms.uOvercast.value = overcast
    this.copyMaterial.uniforms.uOvercast.value = overcast
  }

  setFlash(value: number, direction?: THREE.Vector3) {
    this.mesh.material.uniforms.uFlash.value = value
    if (direction) this.mesh.material.uniforms.uFlashDirection.value.copy(direction)
  }

  setLighting(direction: THREE.Vector3, coverage: number, daylight: number, options: { moon?: THREE.Vector3; immediate?: boolean } = {}) {
    const nextSun = direction.clone().transformDirection(worldToECEF)
    const nextMoon = options.moon?.clone().transformDirection(worldToECEF) ?? nextSun.clone().negate()
    if (!nextSun.equals(this.sun) || !nextMoon.equals(this.moon)) {
      this.lightingChanged = true
      if (options.immediate !== false) this.dirty = true
    }
    if (coverage !== this.coverage) this.dirty = true
    this.sun.copy(nextSun)
    this.moon.copy(nextMoon)
    this.coverage = coverage
    this.mesh.material.uniforms.uDaylight.value = daylight
    this.copyMaterial.uniforms.uDaylight.value = daylight
  }

  sunLightColor(result: THREE.Color) {
    const texture = this.view.atmosphere.transmittanceTexture
    return texture ? getSunLightColor(texture, weatherOrigin, this.sun, result) : result.setRGB(1, 0.96, 0.89)
  }

  update(time: number, force = false, elapsedSeconds = time) {
    if (!this.loaded || this.disposed) return
    this.camera.updateMatrixWorld()
    const cameraChanged = !this.previousCamera.equals(this.camera.matrixWorld)
    // 设置变化时仍需跑完 16 帧的完整采样周期，
    // 即使处于暂停。要在不推进天气/模拟时间的前提下把画面收敛完。
    if (force || this.dirty || this.lightingChanged || cameraChanged || time !== this.lastTime) this.settleFrames = 32
    if (this.settleFrames <= 0) return
    this.settleFrames--
    const renderer = this.renderer
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel()
    const alpha = renderer.getClearAlpha(), scissorTest = renderer.getScissorTest()
    renderer.getClearColor(this.clearColor)
    renderer.getViewport(this.viewport)
    renderer.getScissor(this.scissor)
    try {
      renderer.setScissorTest(false)
      this.view.render(renderer, this.camera, this.sun, this.moon, this.coverage, time)
      // 天气过渡期间 coverage / exposure 每帧都在变。一次刷满 6 个面意味着
      // 单帧里多跑 6 遍体积云（每遍还要重算云阴影），这是最明显的卡顿来源；
      // 改成每帧只更新 1 个面，6 帧（约 0.1 秒）内照样把立方体贴图转完一圈。
      if (this.dirty || this.lightingChanged) this.cubeSweep = 6
      const faces = force
        ? 6
        : this.cubeSweep > 0 || elapsedSeconds - this.lastReflectionTime >= 0.25 ? 1 : 0
      if (this.cubeSweep > 0) this.cubeSweep--
      if (faces > 0) {
        this.cubeCamera.position.copy(this.camera.position)
        this.cubeCamera.updateMatrixWorld(true)
        for (let i = 0; i < faces; i++) {
          const cubeFace = this.nextFace++ % 6
          this.reflection.render(renderer, this.cubeCamera.children[cubeFace] as THREE.Camera, this.sun, this.moon, this.coverage, time)
          renderer.setRenderTarget(this.cubeTarget, cubeFace)
          renderer.render(this.copyScene, this.copyCamera)
        }
        this.lastReflectionTime = elapsedSeconds
      }
      this.previousCamera.copy(this.camera.matrixWorld)
      this.lastTime = time
      this.dirty = false
      this.lightingChanged = false
    } finally {
      renderer.setRenderTarget(target, face, mip)
      renderer.setClearColor(this.clearColor, alpha)
      renderer.setViewport(this.viewport)
      renderer.setScissor(this.scissor)
      renderer.setScissorTest(scissorTest)
    }
  }

  dispose() {
    this.disposed = true
    this.view.dispose()
    this.reflection.dispose()
    this.cubeTarget.dispose()
    this.copyQuad.geometry.dispose()
    this.copyMaterial.dispose()
    this.assets.forEach(texture => texture.dispose())
    this.assets.clear()
    // 显示用的网格与材质由 OceanScene 的场景树统一释放。
  }
}
