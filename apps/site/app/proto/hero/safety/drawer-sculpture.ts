import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { SafetySculpture } from './scene-types'

type BowlSection = { width: number; depth: number; radius: number; y: number }

function roundedOutline(width: number, depth: number, radius: number) {
  const points: THREE.Vector2[] = []
  const corners = [
    [width / 2 - radius, depth / 2 - radius, 0],
    [-width / 2 + radius, depth / 2 - radius, Math.PI / 2],
    [-width / 2 + radius, -depth / 2 + radius, Math.PI],
    [width / 2 - radius, -depth / 2 + radius, (Math.PI * 3) / 2],
  ]

  for (const [x, z, start] of corners) {
    for (let step = 0; step <= 16; step++) {
      const angle = start + (step / 16) * (Math.PI / 2)
      points.push(new THREE.Vector2(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius))
    }
  }
  return points
}

function bowlGeometry(sections: BowlSection[]) {
  const positions: number[] = []
  const indices: number[] = []
  const ringLength = 68

  for (const section of sections) {
    const outline = roundedOutline(section.width, section.depth, section.radius)
    for (const point of outline) positions.push(point.x, section.y, point.y)
  }

  const geometry = new THREE.BufferGeometry()
  for (let ring = 0; ring < sections.length - 1; ring++) {
    const start = indices.length
    for (let point = 0; point < ringLength; point++) {
      const next = (point + 1) % ringLength
      const a = ring * ringLength + point
      const b = (ring + 1) * ringLength + point
      const c = ring * ringLength + next
      const d = (ring + 1) * ringLength + next
      indices.push(a, b, c, c, b, d)
    }
    geometry.addGroup(start, indices.length - start, ring < 7 ? 0 : 1)
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function roundedFloor(width: number, depth: number, radius: number) {
  const outline = roundedOutline(width, depth, radius)
  const shape = new THREE.Shape(outline)
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

function feltMaterial(color: string) {
  const material = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.87,
    metalness: 0,
    sheen: 0.5,
    sheenColor: '#6598ff',
    sheenRoughness: 0.78,
    clearcoat: 0.025,
  })

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDrawerSurface;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDrawerSurface = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDrawerSurface;')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        vec2 grainCell = floor(vDrawerSurface.xz * 135.0);
        float nap = fract(sin(dot(grainCell, vec2(12.9898, 78.233))) * 43758.5453);
        float edgeDistance = min(3.26 - abs(vDrawerSurface.x), 1.36 - abs(vDrawerSurface.z));
        float contactShade = mix(0.79, 1.0, smoothstep(0.01, 0.24, edgeDistance));
        diffuseColor.rgb *= contactShade * (0.975 + nap * 0.025);
        roughnessFactor *= 0.96 + nap * 0.04;`
      )
  }
  material.customProgramCacheKey = () => 'remember-drawer-felt-v1'
  return material
}

function pullTabGeometry() {
  const profile = new THREE.Shape()
  profile.moveTo(1.49, 0.56)
  profile.bezierCurveTo(1.82, 0.56, 2.21, 0.51, 2.27, 0.34)
  profile.bezierCurveTo(2.36, 0.11, 2.08, 0.015, 1.73, 0.065)
  profile.lineTo(1.72, 0.15)
  profile.bezierCurveTo(1.99, 0.12, 2.18, 0.17, 2.18, 0.29)
  profile.bezierCurveTo(2.17, 0.4, 1.82, 0.45, 1.49, 0.45)
  profile.closePath()
  const geometry = new THREE.ExtrudeGeometry(profile, {
    depth: 0.68,
    steps: 1,
    curveSegments: 24,
    bevelEnabled: true,
    bevelSize: 0.023,
    bevelThickness: 0.023,
    bevelSegments: 3,
  })
  geometry.translate(0, 0, -0.34)
  geometry.rotateY(-Math.PI / 2)
  return geometry
}

export function createDrawerSculpture(): SafetySculpture {
  const group = new THREE.Group()
  group.name = 'Remember ceramic memory drawer'
  const tray = new THREE.Group()
  tray.name = 'Sliding cobalt-lined tray'
  tray.position.z = 0.12
  group.add(tray)

  const ceramic = new THREE.MeshPhysicalMaterial({
    color: '#f5f5f2',
    roughness: 0.23,
    metalness: 0.035,
    clearcoat: 0.48,
    clearcoatRoughness: 0.2,
    ior: 1.46,
    specularIntensity: 0.65,
  })
  const housingMaterial = new THREE.MeshPhysicalMaterial({
    color: '#e8eae9',
    roughness: 0.32,
    metalness: 0.08,
    clearcoat: 0.25,
    clearcoatRoughness: 0.3,
  })
  const cobalt = feltMaterial('#1556df')
  const tabMaterial = feltMaterial('#0e4ad1')
  const tabEdge = new THREE.MeshStandardMaterial({ color: '#103bb0', roughness: 0.62 })
  const aluminum = new THREE.MeshStandardMaterial({ color: '#b7c1cd', metalness: 0.84, roughness: 0.3 })
  const seam = new THREE.MeshStandardMaterial({ color: '#414b5c', roughness: 0.85 })

  const add = (
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    x: number,
    y: number,
    z: number
  ) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }

  const housing = add(group, new RoundedBoxGeometry(7.6, 0.32, 3.64, 5, 0.145), housingMaterial, 0, -0.28, -0.04)
  housing.name = 'Soft ceramic lower housing'
  add(group, new RoundedBoxGeometry(7.12, 0.055, 3.13, 3, 0.025), seam, 0, -0.096, -0.01)

  for (const side of [-1, 1]) {
    add(group, new RoundedBoxGeometry(0.24, 0.51, 3.36, 4, 0.105), housingMaterial, side * 3.65, 0.105, -0.13)
    add(group, new RoundedBoxGeometry(0.13, 0.06, 3.1, 2, 0.025), aluminum, side * 3.28, -0.08, 0.07)
    add(tray, new RoundedBoxGeometry(0.075, 0.035, 2.83, 2, 0.015), aluminum, side * 3.28, -0.045, -0.02)
    for (const z of [-1.32, 1.25]) {
      add(group, new RoundedBoxGeometry(0.53, 0.08, 0.42, 3, 0.035), seam, side * 2.9, -0.47, z)
    }
  }
  add(group, new RoundedBoxGeometry(7.16, 0.51, 0.24, 4, 0.105), housingMaterial, 0, 0.105, -1.73)

  const sections: BowlSection[] = [
    { width: 6.95, depth: 3.11, radius: 0.36, y: -0.075 },
    { width: 7.09, depth: 3.25, radius: 0.43, y: -0.035 },
    { width: 7.16, depth: 3.32, radius: 0.47, y: 0.04 },
    { width: 7.16, depth: 3.32, radius: 0.47, y: 0.49 },
    { width: 7.13, depth: 3.29, radius: 0.455, y: 0.61 },
    { width: 7.05, depth: 3.21, radius: 0.415, y: 0.68 },
    { width: 6.88, depth: 3.04, radius: 0.33, y: 0.705 },
    { width: 6.7, depth: 2.86, radius: 0.24, y: 0.68 },
    { width: 6.59, depth: 2.75, radius: 0.2, y: 0.605 },
    { width: 6.55, depth: 2.71, radius: 0.18, y: 0.46 },
    { width: 6.49, depth: 2.65, radius: 0.15, y: 0.39 },
  ]
  const bowl = add(tray, bowlGeometry(sections), [ceramic, cobalt], 0, 0, 0)
  bowl.name = 'Continuous glazed rim and recessed blue lining'
  add(tray, new RoundedBoxGeometry(6.97, 0.43, 3.12, 4, 0.13), ceramic, 0, 0.15, 0)
  const lining = add(tray, roundedFloor(6.5, 2.66, 0.16), cobalt, 0, 0.391, 0)
  lining.name = 'Cobalt memory-catching surface'
  const pullAssembly = new THREE.Group()
  pullAssembly.position.set(0, 0.5, 1.49)
  tray.add(pullAssembly)
  const tabGeometry = pullTabGeometry()
  tabGeometry.translate(0, -0.5, -1.49)
  const pullTab = add(pullAssembly, tabGeometry, [tabMaterial, tabEdge], 0, 0, 0)
  pullTab.name = 'Soft loop pull tab'

  for (const y of [0.235, 0.285, 0.335]) {
    const groove = add(
      pullAssembly,
      new RoundedBoxGeometry(0.39, 0.009, 0.009, 2, 0.004),
      tabEdge,
      0,
      y - 0.5,
      2.274 - 1.49
    )
    groove.castShadow = false
  }

  let target = 0
  let position = 0
  let velocity = 0
  let wasDragging = false
  let dragOrigin = 0
  let dragStart = 0
  let disposed = false

  return {
    group,
    landing(index) {
      const slot = ((index % 8) + 8) % 8
      const column = slot % 4
      const row = Math.floor(slot / 4)
      const point = new THREE.Vector3((column - 1.5) * 1.28, 0.402 + slot * 0.0002, (row - 0.5) * 0.72)
      tray.localToWorld(point)
      return {
        position: point,
        rotation: new THREE.Euler(-Math.PI / 2, 0, (slot % 3 === 0 ? -1 : 1) * 0.018),
      }
    },
    isOpen() {
      return target > 0.38
    },
    setOpen(open) {
      target = open ? 1 : 0
    },
    update(frame) {
      if (disposed) return
      if (frame.dragging) {
        if (!wasDragging) {
          dragOrigin = position
          dragStart = frame.drag
        }
        target = THREE.MathUtils.clamp(dragOrigin + (frame.drag - dragStart) * 1.65, 0, 1)
      } else if (wasDragging) {
        target = target > 0.38 ? 1 : 0
      }
      wasDragging = frame.dragging

      if (frame.reducedMotion) {
        position = target
        velocity = 0
      } else {
        const elapsed = Math.min(Math.max(frame.dt, 0), 0.05)
        const steps = Math.max(1, Math.ceil(elapsed / (1 / 120)))
        const dt = elapsed / steps
        for (let step = 0; step < steps; step++) {
          velocity += ((target - position) * 170 - velocity * 20) * dt
          position += velocity * dt
        }
        if (Math.abs(target - position) < 0.0001 && Math.abs(velocity) < 0.001) {
          position = target
          velocity = 0
        }
      }
      tray.position.z = 0.12 + position * 1.25
      const tabFlex = frame.reducedMotion ? 0 : THREE.MathUtils.clamp(-velocity * 0.035, -0.075, 0.055)
      pullAssembly.rotation.x = frame.reducedMotion
        ? 0
        : THREE.MathUtils.lerp(pullAssembly.rotation.x, tabFlex, 1 - Math.exp(-frame.dt * 22))
    },
    dispose() {
      disposed = true
    },
  }
}
