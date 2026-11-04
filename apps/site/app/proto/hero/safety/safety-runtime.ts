import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createDrawerSculpture } from './drawer-sculpture'
import { createNetSculpture } from './net-sculpture'
import { createRibbonSculpture } from './ribbon-sculpture'
import type { CatchImpact, SceneVariant } from './scene-types'
import { createWorkFragment, workFragments } from './work-fragments'

export type SafetyRuntime = {
  pause: (value: boolean) => void
  drop: () => void
  recall: (index: number) => void
  recallNext: () => void
  open: (value: boolean) => void
  dispose: () => void
}

type Options = {
  variant: SceneVariant
  onCapture: (count: number) => void
  onSelect: (index: number | null) => void
  onReady: (reducedMotion: boolean) => void
  onOpenChange: (open: boolean) => void
}

export function createSafetyRuntime(container: HTMLElement, options: Options): SafetyRuntime {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.92
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.VSMShadowMap
  renderer.setClearColor('#ffffff', 0)
  container.appendChild(renderer.domElement)
  renderer.domElement.setAttribute('aria-hidden', 'true')

  const scene = new THREE.Scene()
  const environment = new RoomEnvironment()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envMap = pmrem.fromScene(environment, 0.04)
  scene.environment = envMap.texture
  scene.environmentIntensity = 0.8
  environment.dispose()
  pmrem.dispose()

  const camera = new THREE.OrthographicCamera(-6, 6, 3, -3, 0.1, 100)
  const focus = new THREE.Vector3(0, options.variant === 'drawer' ? 0.1 : options.variant === 'net' ? 0.5 : 1.1, 0)
  camera.position.set(7, focus.y + 7.3, 12)
  camera.lookAt(focus)
  const recallPosition = camera.position.clone().sub(focus).normalize().multiplyScalar(6).add(focus)
  scene.add(new THREE.HemisphereLight('#ffffff', '#bac7e7', 0.8))
  const key = new THREE.DirectionalLight('#fff9ee', 2.4)
  key.position.set(-4, 9, 5)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.radius = 5
  key.shadow.blurSamples = 8
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.1, far: 25 })
  key.shadow.normalBias = 0.025
  key.shadow.bias = -0.0004
  scene.add(key)
  const fill = new THREE.DirectionalLight('#d9e7ff', 0.8)
  fill.position.set(4, 3, -4)
  scene.add(fill)

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.08 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.56
  floor.receiveShadow = true
  scene.add(floor)

  const sculpture =
    options.variant === 'net'
      ? createNetSculpture()
      : options.variant === 'ribbon'
        ? createRibbonSculpture()
        : createDrawerSculpture()
  scene.add(sculpture.group)
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reducedMotion = motion.matches
  let paused = reducedMotion
  let visible = true
  let disposed = false
  let time = 0
  let lastTime = 0
  let raf = 0
  let nextDrop = 0.7
  let dropIndex = 2
  let selected: number | null = null
  let caught = 2
  let held: number | null = null
  let pointerDown = false
  let drag = 0
  let startY = 0
  let startX = 0
  let moved = false
  let lastRender = 0
  let wasOpen = false
  const pointer = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const impactEvents: CatchImpact[] = []
  const targetPosition = new THREE.Vector3()
  const targetQuaternion = new THREE.Quaternion()
  const lookQuaternion = camera.quaternion.clone()
  const scaleVector = new THREE.Vector3()
  const restingTwist = new THREE.Quaternion()
  const grabPlane = new THREE.Plane()
  const grabbedPosition = new THREE.Vector3()
  const planeNormal = new THREE.Vector3()
  camera.getWorldDirection(planeNormal)

  const fragments = workFragments.map((_, index) => {
    const mesh = createWorkFragment(index)
    mesh.scale.setScalar(0.82)
    const landing = sculpture.landing(index)
    mesh.position.copy(landing.position)
    mesh.position.y += 0.06
    mesh.rotation.copy(landing.rotation)
    const initial = reducedMotion || index < 2
    mesh.visible = initial
    scene.add(mesh)
    return { mesh, status: initial ? 'caught' : 'waiting', velocity: 0, bounce: 0, spin: (index % 2 ? 1 : -1) * 0.24 }
  })
  if (reducedMotion) caught = fragments.length

  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    renderer.setSize(width, height)
    const aspect = width / height
    const viewWidth = aspect < 1.2 ? 9.4 : 12.4
    const viewHeight = viewWidth / aspect
    camera.left = -viewWidth / 2
    camera.right = viewWidth / 2
    camera.top = viewHeight / 2
    camera.bottom = -viewHeight / 2
    camera.updateProjectionMatrix()
    draw()
  }

  function draw() {
    if (!disposed) renderer.render(scene, camera)
  }

  function drop() {
    const index = dropIndex++ % fragments.length
    if (index === selected || index === held) return
    const fragment = fragments[index]
    const landing = sculpture.landing(index)
    if (fragment.status === 'caught') caught--
    fragment.status = reducedMotion ? 'caught' : 'falling'
    fragment.mesh.visible = true
    fragment.mesh.position.copy(landing.position)
    fragment.mesh.position.y = reducedMotion ? landing.position.y + 0.06 : 5 + (index % 3) * 0.35
    fragment.mesh.rotation.set(-0.65, 0.25 * Math.sin(index), (index % 2 ? 1 : -1) * 0.24)
    fragment.velocity = -0.5
    fragment.bounce = 0
    if (reducedMotion) {
      caught++
      fragment.mesh.rotation.copy(landing.rotation)
    }
    options.onCapture(caught)
    if (paused && !reducedMotion) {
      // The explicit drop button runs one fall even while autoplay is paused.
      nextDrop = Math.max(nextDrop, time + 4)
    }
    wake()
  }

  function recall(index: number) {
    const fragment = fragments[index]
    if (fragment?.status !== 'caught') return
    selected = selected === index ? null : index
    options.onSelect(selected)
    if (reducedMotion) {
      placeFragments(1)
      draw()
    }
    wake()
  }

  function placeFragments(dt: number) {
    const blend = reducedMotion ? 1 : 1 - Math.exp(-dt * 10)
    fragments.forEach((fragment, index) => {
      if (fragment.status !== 'caught') return
      fragment.mesh.children[0].castShadow = selected !== index && held !== index
      const landing = sculpture.landing(index)
      targetPosition.copy(landing.position)
      targetPosition.y += 0.055
      targetQuaternion.setFromEuler(landing.rotation)
      restingTwist.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(index * 3.7) * 0.12)
      targetQuaternion.multiply(restingTwist)
      let scale = 0.82
      if (selected === index) {
        targetPosition.copy(recallPosition)
        targetQuaternion.copy(lookQuaternion)
        scale = container.clientWidth < 600 ? 3.5 : 1.85
      }
      if (held === index) {
        targetPosition.copy(grabbedPosition)
        targetQuaternion.copy(lookQuaternion)
        scale = 1.25
      }
      fragment.mesh.position.lerp(targetPosition, blend)
      fragment.mesh.quaternion.slerp(targetQuaternion, blend)
      fragment.mesh.scale.lerp(scaleVector.setScalar(scale), blend)
    })
  }

  function tick(timestamp: number) {
    raf = 0
    if (disposed || !visible || document.hidden) return
    const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.034) : 0.016
    lastTime = timestamp
    time += dt
    impactEvents.forEach((impact) => {
      impact.age += dt
    })
    while (impactEvents[0]?.age > 4) impactEvents.shift()
    sculpture.update({
      dt,
      time,
      pointer,
      dragging: pointerDown && held === null,
      drag,
      impacts: impactEvents,
      reducedMotion,
    })
    const isOpen = sculpture.isOpen?.() ?? false
    if (isOpen !== wasOpen) {
      wasOpen = isOpen
      options.onOpenChange(isOpen)
    }
    if (!paused && selected === null && !pointerDown && time > nextDrop) {
      drop()
      nextDrop = time + (dropIndex < 8 ? 1.5 : 3.6)
    }

    for (let index = 0; index < fragments.length; index++) {
      const fragment = fragments[index]
      if (fragment.status !== 'falling') continue
      const landing = sculpture.landing(index)
      fragment.velocity -= 7.8 * dt
      fragment.mesh.position.y += fragment.velocity * dt
      fragment.mesh.rotation.z += fragment.spin * dt
      fragment.mesh.quaternion.slerp(targetQuaternion.setFromEuler(landing.rotation), dt * 2.7)
      fragment.mesh.position.x += (landing.position.x - fragment.mesh.position.x) * dt * 5
      fragment.mesh.position.z += (landing.position.z - fragment.mesh.position.z) * dt * 5
      if (fragment.mesh.position.y <= landing.position.y + 0.055) {
        fragment.mesh.position.y = landing.position.y + 0.055
        if (fragment.bounce === 0 && Math.abs(fragment.velocity) > 1) {
          impactEvents.push({
            x: landing.position.x,
            z: landing.position.z,
            age: 0,
            strength: Math.min(1, Math.abs(fragment.velocity) / 7),
          })
          fragment.velocity = Math.abs(fragment.velocity) * 0.18
          fragment.bounce++
        } else {
          fragment.status = 'caught'
          fragment.velocity = 0
          caught++
          options.onCapture(caught)
        }
      }
    }
    placeFragments(dt)
    draw()
    const active =
      !paused ||
      pointerDown ||
      fragments.some((f) => f.status === 'falling') ||
      impactEvents.length > 0 ||
      timestamp - lastRender < 1400
    if (active && !reducedMotion && !raf) raf = requestAnimationFrame(tick)
  }

  function wake() {
    if (disposed || !visible || document.hidden) return
    lastRender = performance.now()
    if (!raf) {
      lastTime = 0
      raf = requestAnimationFrame(tick)
    }
  }

  function updatePointer(event: PointerEvent) {
    const bounds = renderer.domElement.getBoundingClientRect()
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1
    )
    raycaster.setFromCamera(pointer, camera)
  }

  function fragmentAtPointer() {
    const hits = raycaster.intersectObjects(
      fragments.filter((f) => f.status === 'caught').map((f) => f.mesh),
      true
    )
    const hit = hits[0]
    if (!hit) return null
    if (options.variant === 'drawer') {
      const blockers = raycaster.intersectObject(sculpture.group, true)
      if (blockers[0] && blockers[0].distance < hit.distance - 0.01) return null
    }
    let object: THREE.Object3D | null = hit.object
    while (object && typeof object.userData.fragmentIndex !== 'number') object = object.parent
    return object ? Number(object.userData.fragmentIndex) : null
  }

  function onDown(event: PointerEvent) {
    if (event.button !== 0) return
    updatePointer(event)
    held = fragmentAtPointer()
    pointerDown = true
    moved = false
    startY = event.clientY
    startX = event.clientX
    renderer.domElement.setPointerCapture(event.pointerId)
    if (held !== null) {
      grabPlane.setFromNormalAndCoplanarPoint(planeNormal, fragments[held].mesh.position)
      raycaster.ray.intersectPlane(grabPlane, grabbedPosition)
    }
    container.dataset.dragging = 'true'
    wake()
  }

  function onMove(event: PointerEvent) {
    updatePointer(event)
    if (pointerDown) {
      moved ||= Math.hypot(event.clientY - startY, event.clientX - startX) > 5
      if (held !== null) raycaster.ray.intersectPlane(grabPlane, grabbedPosition)
      else
        drag = THREE.MathUtils.clamp(
          (event.pointerType === 'touch' ? event.clientX - startX : event.clientY - startY) / 180,
          -1,
          1
        )
      wake()
    } else {
      container.dataset.hovered = fragmentAtPointer() !== null ? 'true' : 'false'
    }
  }

  function onUp(event: PointerEvent) {
    const index = held
    held = null
    pointerDown = false
    drag = 0
    container.dataset.dragging = 'false'
    if (renderer.domElement.hasPointerCapture(event.pointerId))
      renderer.domElement.releasePointerCapture(event.pointerId)
    if (index !== null && !moved) recall(index)
    else wake()
  }

  function onCancel(event: PointerEvent) {
    moved = true
    onUp(event)
  }

  function onVisibility() {
    if (document.hidden && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    } else wake()
  }

  function onMotion() {
    reducedMotion = motion.matches
    paused = reducedMotion
    if (reducedMotion) {
      fragments.forEach((f) => {
        f.status = 'caught'
        f.mesh.visible = true
      })
      caught = fragments.length
      options.onCapture(caught)
      placeFragments(1)
    }
    options.onReady(reducedMotion)
    wake()
  }

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  const intersection = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting
      if (visible) wake()
      else if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    },
    { rootMargin: '100px' }
  )
  intersection.observe(container)
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointermove', onMove)
  renderer.domElement.addEventListener('pointerup', onUp)
  renderer.domElement.addEventListener('pointercancel', onCancel)
  document.addEventListener('visibilitychange', onVisibility)
  motion.addEventListener('change', onMotion)
  resize()
  options.onCapture(caught)
  options.onReady(reducedMotion)
  wake()

  return {
    pause(value) {
      paused = value || reducedMotion
      wake()
    },
    drop,
    recall,
    recallNext() {
      for (let step = 1; step <= fragments.length; step++) {
        const index = ((selected ?? -1) + step) % fragments.length
        if (fragments[index].status === 'caught') {
          recall(index)
          break
        }
      }
    },
    open(value) {
      sculpture.setOpen?.(value)
      wake()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      motion.removeEventListener('change', onMotion)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onCancel)
      sculpture.dispose()
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      const textures = new Set<THREE.Texture>()
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return
        geometries.add(object.geometry)
        const list = Array.isArray(object.material) ? object.material : [object.material]
        list.forEach((material) => {
          materials.add(material)
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
        })
      })
      geometries.forEach((geometry) => {
        geometry.dispose()
      })
      materials.forEach((material) => {
        material.dispose()
      })
      textures.forEach((texture) => {
        texture.dispose()
      })
      envMap.dispose()
      key.shadow.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
