import * as THREE from 'three'
import type { CatchImpact, SafetySculpture, SculptureFrame } from './scene-types'

const LENGTH_SEGMENTS = 144
const FACE_SEGMENTS = 18
const EDGE_SEGMENTS = 8
const HALF_THICKNESS = 0.095

type RibbonSection = {
  center: THREE.Vector3
  normal: THREE.Vector3
  across: THREE.Vector3
  halfWidth: number
}

type Deformable = {
  geometry: THREE.BufferGeometry
  resting: Float32Array
}

const curves = [
  new THREE.CubicBezierCurve3(
    new THREE.Vector3(-3.18, 2.45, -0.28),
    new THREE.Vector3(-4.55, 2.66, -0.1),
    new THREE.Vector3(-3.4, -0.15, 0.1),
    new THREE.Vector3(-2.1, -0.15, 0.1)
  ),
  new THREE.CubicBezierCurve3(
    new THREE.Vector3(-2.1, -0.15, 0.1),
    new THREE.Vector3(-0.8, -0.15, 0.1),
    new THREE.Vector3(0.7, -0.15, 0.05),
    new THREE.Vector3(1.8, -0.1, 0.05)
  ),
  new THREE.CubicBezierCurve3(
    new THREE.Vector3(1.8, -0.1, 0.05),
    new THREE.Vector3(2.9, -0.05, 0.05),
    new THREE.Vector3(4.34, 1, -0.22),
    new THREE.Vector3(3.35, 1.88, -0.34)
  ),
]

function sectionAt(t: number): RibbonSection {
  const part = t < 0.36 ? 0 : t < 0.68 ? 1 : 2
  const start = [0, 0.36, 0.68][part]
  const span = [0.36, 0.32, 0.32][part]
  const local = THREE.MathUtils.clamp((t - start) / span, 0, 1)
  const center = curves[part].getPoint(local)
  const tangent = curves[part].getTangent(local).normalize()
  const upright = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize()
  const sideways = new THREE.Vector3().crossVectors(tangent, upright).normalize()
  const bank = -0.19 * (1 - t) ** 3 + 0.27 * t ** 4
  const normal = upright.clone().multiplyScalar(Math.cos(bank)).addScaledVector(sideways, -Math.sin(bank))
  const across = sideways.multiplyScalar(Math.cos(bank)).addScaledVector(upright, Math.sin(bank))

  return { center, normal, across, halfWidth: 1.31 + Math.sin(t * Math.PI) * 0.12 }
}

function sectionPoint(section: RibbonSection, across: number, height: number) {
  const cup = 0.055 * (across / section.halfWidth) ** 2

  return section.center
    .clone()
    .addScaledVector(section.across, across)
    .addScaledVector(section.normal, height + cup)
}

/** A single watertight volume: broad faces, rounded cut edges, and closed ends. */
function createGlassGeometry() {
  const positions: number[] = []
  const indices: number[] = []
  const ringLength = 2 * FACE_SEGMENTS + 2 * EDGE_SEGMENTS

  for (let row = 0; row <= LENGTH_SEGMENTS; row += 1) {
    const section = sectionAt(row / LENGTH_SEGMENTS)
    const shoulder = section.halfWidth - HALF_THICKNESS

    for (let vertex = 0; vertex < ringLength; vertex += 1) {
      let across: number
      let height: number

      if (vertex < FACE_SEGMENTS) {
        across = THREE.MathUtils.lerp(-shoulder, shoulder, vertex / FACE_SEGMENTS)
        height = HALF_THICKNESS
      } else if (vertex < FACE_SEGMENTS + EDGE_SEGMENTS) {
        const angle = ((vertex - FACE_SEGMENTS) / EDGE_SEGMENTS) * Math.PI
        across = shoulder + Math.sin(angle) * HALF_THICKNESS
        height = Math.cos(angle) * HALF_THICKNESS
      } else if (vertex < 2 * FACE_SEGMENTS + EDGE_SEGMENTS) {
        const progress = (vertex - FACE_SEGMENTS - EDGE_SEGMENTS) / FACE_SEGMENTS
        across = THREE.MathUtils.lerp(shoulder, -shoulder, progress)
        height = -HALF_THICKNESS
      } else {
        const angle = ((vertex - 2 * FACE_SEGMENTS - EDGE_SEGMENTS) / EDGE_SEGMENTS) * Math.PI
        across = -shoulder - Math.sin(angle) * HALF_THICKNESS
        height = -Math.cos(angle) * HALF_THICKNESS
      }

      const point = sectionPoint(section, across, height)
      positions.push(point.x, point.y, point.z)
    }
  }

  for (let row = 0; row < LENGTH_SEGMENTS; row += 1) {
    for (let column = 0; column < ringLength; column += 1) {
      const next = (column + 1) % ringLength
      const a = row * ringLength + column
      const b = (row + 1) * ringLength + column
      const c = (row + 1) * ringLength + next
      const d = row * ringLength + next
      indices.push(a, c, b, a, d, c)
    }
  }

  for (const end of [0, LENGTH_SEGMENTS]) {
    const center = sectionAt(end / LENGTH_SEGMENTS).center
    const centerIndex = positions.length / 3
    positions.push(center.x, center.y, center.z)

    for (let column = 0; column < ringLength; column += 1) {
      const a = end * ringLength + column
      const b = end * ringLength + ((column + 1) % ringLength)
      indices.push(...(end === 0 ? [centerIndex, b, a] : [centerIndex, a, b]))
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  return geometry
}

function createEdgeGeometry(side: number) {
  const points = Array.from({ length: LENGTH_SEGMENTS + 1 }, (_, index) => {
    const section = sectionAt(index / LENGTH_SEGMENTS)

    return sectionPoint(section, side * (section.halfWidth - 0.075), -0.008)
  })
  const curve = new THREE.CatmullRomCurve3(points)
  const geometry = new THREE.TubeGeometry(curve, LENGTH_SEGMENTS, 0.036, 8, false)
  const position = geometry.attributes.position as THREE.BufferAttribute
  position.setUsage(THREE.DynamicDrawUsage)

  return geometry
}

export function createRibbonSculpture(): SafetySculpture {
  const group = new THREE.Group()
  group.name = 'Remember optical safety ribbon'

  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: '#d4e6ff',
    metalness: 0,
    roughness: 0.11,
    transmission: 0.985,
    thickness: 0.32,
    ior: 1.48,
    attenuationColor: '#6a9fee',
    attenuationDistance: 1.1,
    clearcoat: 1,
    clearcoatRoughness: 0.035,
    envMapIntensity: 0.65,
    dispersion: 0.035,
  })
  const edgeMaterial = new THREE.MeshPhysicalMaterial({
    color: '#0869ff',
    metalness: 0.2,
    roughness: 0.15,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.2,
  })

  const glass = new THREE.Mesh(createGlassGeometry(), glassMaterial)
  glass.name = 'Continuous rounded optical glass'
  glass.receiveShadow = true
  group.add(glass)

  const edges = [-1, 1].map((side) => {
    const edge = new THREE.Mesh(createEdgeGeometry(side), edgeMaterial)
    edge.name = side < 0 ? 'Far cobalt core' : 'Near cobalt core'
    edge.castShadow = true
    group.add(edge)

    return edge
  })
  const deformables: Deformable[] = [glass, ...edges].map(({ geometry }) => ({
    geometry,
    resting: new Float32Array(geometry.attributes.position.array),
  }))

  let bend = 0
  let twist = 0
  let open = false
  let impacts: CatchImpact[] = []
  let reducedMotion = false
  let hadImpacts = false

  function displacement(x: number, z: number) {
    const basin = Math.exp(-((x / 3.25) ** 4))
    let offset = bend * (0.075 * x + 0.09 * Math.cos(x * 0.75)) + twist * z * 0.11 * basin

    if (!reducedMotion) {
      for (const impact of impacts) {
        if (impact.age < 0 || impact.age > 1.8) continue

        const distance = Math.hypot(x - impact.x, z - impact.z)
        const envelope = Math.exp(-impact.age * 3.8 - distance * distance * 0.9)
        offset -= Math.min(impact.strength, 1.5) * 0.11 * envelope * Math.cos(impact.age * 13 - distance * 2.5)
      }
    }

    return offset * basin
  }

  function updateGeometry() {
    for (const { geometry, resting } of deformables) {
      const position = geometry.attributes.position as THREE.BufferAttribute
      const array = position.array as Float32Array

      for (let index = 0; index < resting.length; index += 3) {
        array[index + 1] = resting[index + 1] + displacement(resting[index], resting[index + 2])
      }

      position.needsUpdate = true
      geometry.computeVertexNormals()
    }
  }

  // Find the basin branch, excluding the folded-back lips at the same x coordinate.
  function surfaceAt(x: number, z: number) {
    let low = 0.2
    let high = 0.88

    for (let iteration = 0; iteration < 22; iteration += 1) {
      const middle = (low + high) / 2
      if (sectionAt(middle).center.x < x) low = middle
      else high = middle
    }

    const section = sectionAt((low + high) / 2)
    const across = (z - section.center.z) / section.across.z
    return sectionPoint(section, across, HALF_THICKNESS)
  }

  const landingSamples = Array.from({ length: 8 }, (_, index) => {
    const x = -2.1 + (index % 4) * 1.4
    const z = index < 4 ? -0.52 : 0.58

    return {
      center: surfaceAt(x, z),
      left: surfaceAt(x - 0.02, z),
      right: surfaceAt(x + 0.02, z),
      front: surfaceAt(x, z + 0.02),
      back: surfaceAt(x, z - 0.02),
    }
  })

  function update(frame: SculptureFrame) {
    impacts = frame.impacts
    reducedMotion = frame.reducedMotion
    const targetBend = frame.dragging ? THREE.MathUtils.clamp(frame.drag, -1, 1) : open ? 0.6 : 0
    const targetTwist = frame.dragging ? THREE.MathUtils.clamp(frame.pointer.x, -1, 1) : 0
    const response = reducedMotion ? 1 : 1 - Math.exp(-Math.min(frame.dt, 0.05) * 18)
    const previousBend = bend
    const previousTwist = twist
    bend = THREE.MathUtils.lerp(bend, targetBend, response)
    twist = THREE.MathUtils.lerp(twist, targetTwist, response)

    if (Math.abs(bend - targetBend) < 0.0001) bend = targetBend
    if (Math.abs(twist - targetTwist) < 0.0001) twist = targetTwist

    const hasImpacts = !reducedMotion && impacts.some(({ age }) => age >= 0 && age <= 1.8)

    if (bend !== previousBend || twist !== previousTwist || hasImpacts || hadImpacts) updateGeometry()
    hadImpacts = hasImpacts
  }

  return {
    group,
    update,
    landing(index) {
      const { center, left, right, front, back } = landingSamples[((index % 8) + 8) % 8]
      const position = center.clone()
      position.y += displacement(center.x, center.z)
      const along = right.clone().sub(left)
      along.y += displacement(right.x, right.z) - displacement(left.x, left.z)
      along.normalize()
      const across = front.clone().sub(back)
      across.y += displacement(front.x, front.z) - displacement(back.x, back.z)
      across.normalize()
      const normal = new THREE.Vector3().crossVectors(across, along).normalize()
      const up = new THREE.Vector3().crossVectors(normal, along).normalize()
      const rotation = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, up, normal))
      position.addScaledVector(normal, 0.025)

      return { position, rotation }
    },
    setOpen(value) {
      open = value
    },
    dispose() {
      // The scene owns disposal of the traversed geometry and materials.
      impacts = []
    },
  }
}
