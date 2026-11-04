export type TijdFrame = {
  progress: number
  x: number
  y: number
  width: number
  height: number
  dialWidth: number
  dialHeight: number
}

export type TijdRenderer = {
  begin: (pointerAngle: number) => void
  drag: (pointerAngle: number) => void
  release: () => void
  select: (index: number) => void
  dispose: () => void
}

type Mesh = { buffer: WebGLBuffer; count: number; material: number; rotating: boolean; texture: WebGLTexture | null }
type ProfilePoint = readonly [radius: number, height: number]

const TAU = Math.PI * 2
const NOTCH = TAU / 3
const TIMES = ['10:30', '15:00', '16:32']

const vertexSource = `
attribute vec3 position;
attribute vec3 normal;
uniform mat4 projection;
uniform mat4 view;
uniform float rotation;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying vec2 faceUv;

void main() {
  float c = cos(rotation), s = sin(rotation);
  worldPosition = vec3(c * position.x - s * position.z, position.y, s * position.x + c * position.z);
  worldNormal = vec3(c * normal.x - s * normal.z, normal.y, s * normal.x + c * normal.z);
  faceUv = position.xz / 4.4 + 0.5;
  gl_Position = projection * view * vec4(worldPosition, 1.0);
}
`

const fragmentSource = `
precision highp float;
uniform vec3 eye;
uniform float material;
uniform bool hasTexture;
uniform sampler2D faceTexture;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying vec2 faceUv;

vec3 studio(vec3 direction) {
  vec3 color = mix(vec3(0.15, 0.19, 0.25), vec3(0.94, 0.97, 1.0), smoothstep(-0.55, 0.6, direction.y));
  float softbox = exp(-pow((direction.x + 0.44) / 0.3, 4.0)) * smoothstep(0.05, 0.7, direction.y);
  color += vec3(0.7, 0.72, 0.75) * softbox;
  float darkFlag = exp(-pow((direction.x - 0.48) / 0.11, 2.0));
  color = mix(color, vec3(0.10, 0.13, 0.18), darkFlag * 0.77);
  float edgeStrip = exp(-pow((direction.z + 0.26) / 0.065, 2.0));
  color += vec3(0.8, 0.84, 0.9) * edgeStrip;
  return color;
}

void main() {
  vec3 n = normalize(worldNormal);
  vec3 v = normalize(eye - worldPosition);
  vec3 light = normalize(vec3(-3.0, 6.0, 4.0));
  vec3 halfDirection = normalize(light + v);
  float facing = max(dot(n, v), 0.0);
  float diffuse = max(dot(n, light), 0.0);
  float radius = length(worldPosition.xz);
  float side = 1.0 - abs(n.y);
  vec3 reflected = studio(reflect(-v, n));
  vec3 color;

  if (material < 0.5) {
    float brushing = sin(radius * 1250.0) * 0.002;
    color = mix(vec3(0.77, 0.80, 0.84) * (0.79 + diffuse * 0.21), reflected, 0.22 + side * 0.18);
    color += brushing;
    color += vec3(0.95) * pow(max(dot(n, halfDirection), 0.0), 65.0) * 0.24;
    color *= 0.92 + 0.08 * smoothstep(-0.1, 0.25, worldPosition.y);
  } else if (material < 1.5) {
    color = vec3(0.945, 0.953, 0.964) * (0.86 + diffuse * 0.14);
    color = mix(color, reflected, 0.055 + pow(1.0 - facing, 4.0) * 0.3);
    float recessShadow = smoothstep(1.38, 1.69, radius) * 0.095;
    color *= 1.0 - recessShadow;
    color += vec3(0.13) * pow(max(dot(n, halfDirection), 0.0), 85.0);
  } else if (material < 2.5) {
    color = vec3(0.04, 0.29, 0.82) * (0.5 + diffuse * 0.5);
    color = mix(color, reflected, 0.16 + pow(1.0 - facing, 4.0) * 0.4);
    color += vec3(0.7, 0.8, 1.0) * pow(max(dot(n, halfDirection), 0.0), 190.0);
  } else {
    color = vec3(0.16, 0.20, 0.27) * (0.7 + diffuse * 0.3);
    color = mix(color, reflected, 0.12);
  }

  if (hasTexture && n.y > 0.5) {
    vec4 ink = texture2D(faceTexture, faceUv);
    float engravingEdge = texture2D(faceTexture, faceUv + vec2(0.0, 0.0009)).a - ink.a;
    color = mix(color, ink.rgb, ink.a * 0.84);
    color += max(engravingEdge, 0.0) * 0.22;
  }

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`

const shadowVertex = `
attribute vec3 position;
uniform mat4 projection;
uniform mat4 view;
varying vec2 floorPosition;
void main() {
  floorPosition = position.xz;
  gl_Position = projection * view * vec4(position, 1.0);
}
`

const shadowFragment = `
precision mediump float;
varying vec2 floorPosition;
void main() {
  vec2 p = (floorPosition - vec2(0.15, -0.1)) / vec2(2.15, 2.15);
  float contact = exp(-dot(p, p) * 2.5) * 0.22;
  float ambient = exp(-dot(p, p) * 1.2) * 0.11;
  gl_FragColor = vec4(0.27, 0.32, 0.40, contact + ambient);
}
`

function compile(gl: WebGLRenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram()
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)

  if (!program || !vertexShader || !fragmentShader) return null

  gl.shaderSource(vertexShader, vertex)
  gl.shaderSource(fragmentShader, fragment)
  gl.compileShader(vertexShader)
  gl.compileShader(fragmentShader)

  if (
    !gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS) ||
    !gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)
  ) {
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    gl.deleteProgram(program)
    return null
  }

  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  return program
}

function lathe(profile: ReadonlyArray<ProfilePoint>) {
  const vertices: number[] = []
  const segments = 256

  for (let ring = 0; ring < profile.length - 1; ring++) {
    const [r0, y0] = profile[ring]
    const [r1, y1] = profile[ring + 1]
    const length = Math.hypot(r1 - r0, y1 - y0)
    const radialNormal = (y1 - y0) / length
    const verticalNormal = -(r1 - r0) / length

    for (let segment = 0; segment < segments; segment++) {
      const a = (segment / segments) * TAU
      const b = ((segment + 1) / segments) * TAU
      for (const [r, y, theta] of [
        [r0, y0, a],
        [r1, y1, a],
        [r0, y0, b],
        [r0, y0, b],
        [r1, y1, a],
        [r1, y1, b],
      ]) {
        const c = Math.cos(theta)
        const s = Math.sin(theta)
        vertices.push(r * c, y, r * s, radialNormal * c, verticalNormal, radialNormal * s)
      }
    }
  }

  return new Float32Array(vertices)
}

function ortho(left: number, right: number, bottom: number, top: number, near: number, far: number) {
  return new Float32Array([
    2 / (right - left),
    0,
    0,
    0,
    0,
    2 / (top - bottom),
    0,
    0,
    0,
    0,
    -2 / (far - near),
    0,
    -(right + left) / (right - left),
    -(top + bottom) / (top - bottom),
    -(far + near) / (far - near),
    1,
  ])
}

function cameraView(eye: readonly [number, number, number]) {
  const targetY = 0.05
  const length = Math.hypot(eye[0], eye[1] - targetY, eye[2])
  const z = [eye[0] / length, (eye[1] - targetY) / length, eye[2] / length]
  const xLength = Math.hypot(z[2], z[0])
  const x = [z[2] / xLength, 0, -z[0] / xLength]
  const y = [z[1] * x[2], z[2] * x[0] - z[0] * x[2], -z[1] * x[0]]
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -x.reduce((sum, value, index) => sum + value * eye[index], 0),
    -y.reduce((sum, value, index) => sum + value * eye[index], 0),
    -z.reduce((sum, value, index) => sum + value * eye[index], 0),
    1,
  ])
}

function faceCanvas(kind: 'bezel' | 'rotor') {
  const canvas = document.createElement('canvas')
  canvas.width = 1536
  canvas.height = 1536
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const unit = canvas.width / 4.4
  const center = canvas.width / 2

  ctx.translate(center, center)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (kind === 'bezel') {
    for (let tick = 0; tick < 90; tick++) {
      const angle = (tick / 90) * TAU
      const major = tick % 5 === 0
      ctx.save()
      ctx.rotate(angle)
      ctx.strokeStyle = major ? '#8893a3' : '#a9b3c0'
      ctx.lineWidth = major ? 1.8 : 1.2
      ctx.beginPath()
      ctx.moveTo(0, -2.015 * unit)
      ctx.lineTo(0, -(major ? 1.91 : 1.96) * unit)
      ctx.stroke()
      ctx.restore()
    }

    ctx.fillStyle = '#2563eb'
    ctx.beginPath()
    ctx.moveTo(-0.034 * unit, -1.86 * unit)
    ctx.lineTo(0.034 * unit, -1.86 * unit)
    ctx.lineTo(0, -1.78 * unit)
    ctx.closePath()
    ctx.fill()
  }

  if (kind === 'rotor') {
    for (let moment = 0; moment < 3; moment++) {
      ctx.save()
      ctx.rotate(moment * NOTCH)
      ctx.font = '500 28px system-ui, sans-serif'
      ctx.fillStyle = '#6c788b'
      ctx.fillText(TIMES[moment], 0, -1.597 * unit)
      ctx.fillStyle = '#2563eb'
      ctx.beginPath()
      ctx.arc(0.16 * unit, -1.597 * unit, 0.012 * unit, 0, TAU)
      ctx.fill()
      ctx.restore()
    }
  }

  return canvas
}

export function createTijdRenderer(
  canvas: HTMLCanvasElement,
  onSelect: (index: number) => void,
  onReady: (ready: boolean) => void,
  initialIndex = 2,
  onFrame?: (frame: TijdFrame) => void
): TijdRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
  })
  if (!gl) return null

  const program = compile(gl, vertexSource, fragmentSource)
  const shadowProgram = compile(gl, shadowVertex, shadowFragment)
  if (!program || !shadowProgram) {
    if (program) gl.deleteProgram(program)
    if (shadowProgram) gl.deleteProgram(shadowProgram)
    return null
  }

  const meshes: Mesh[] = []
  const textures: WebGLTexture[] = []
  const eye: [number, number, number] = [0, 4.5, 8.0]
  let view = cameraView(eye)
  let cssWidth = 1
  let cssHeight = 1
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let projection = ortho(-5, 5, -1.8, 1.8, 0.1, 30)

  const texture = (kind: 'bezel' | 'rotor') => {
    const value = gl.createTexture()
    if (!value) return null
    gl.bindTexture(gl.TEXTURE_2D, value)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, faceCanvas(kind))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textures.push(value)
    return value
  }

  const addMesh = (
    profile: ReadonlyArray<ProfilePoint>,
    material: number,
    rotating = false,
    face: WebGLTexture | null = null
  ) => {
    const vertices = lathe(profile)
    const buffer = gl.createBuffer()
    if (!buffer) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
    meshes.push({ buffer, count: vertices.length / 6, material, rotating, texture: face })
  }

  addMesh(
    [
      [1.7, -0.12],
      [2.02, -0.12],
      [2.08, -0.105],
      [2.12, -0.065],
      [2.14, -0.005],
      [2.14, 0.205],
      [2.125, 0.265],
      [2.09, 0.305],
      [2.04, 0.325],
      [1.8, 0.325],
      [1.75, 0.305],
      [1.71, 0.265],
      [1.69, 0.205],
      [1.69, -0.06],
      [1.7, -0.12],
    ],
    0,
    false,
    texture('bezel')
  )
  addMesh(
    [
      [1.705, 0.212],
      [1.725, 0.235],
      [1.748, 0.265],
      [1.762, 0.294],
      [1.746, 0.304],
      [1.729, 0.28],
      [1.709, 0.25],
      [1.695, 0.218],
      [1.705, 0.212],
    ],
    2
  )
  addMesh(
    [
      [0, -0.08],
      [1.59, -0.08],
      [1.64, -0.04],
      [1.667, 0.01],
      [1.667, 0.09],
      [1.651, 0.136],
      [1.62, 0.167],
      [1.58, 0.18],
      [0, 0.18],
    ],
    1,
    true,
    texture('rotor')
  )
  // The work sits below a machined aperture, inside the turning time ring.
  addMesh(
    [
      [1.465, 0.159],
      [1.492, 0.159],
      [1.518, 0.18],
      [1.52, 0.197],
      [1.505, 0.208],
      [1.488, 0.197],
      [1.465, 0.174],
      [1.465, 0.159],
    ],
    0
  )
  addMesh(
    [
      [0, 0.153],
      [1.47, 0.153],
      [1.47, 0.167],
      [0, 0.167],
    ],
    1
  )

  const shadowBuffer = gl.createBuffer()
  if (!shadowBuffer) return null
  gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-4, -0.13, -4, 4, -0.13, -4, -4, -0.13, 4, -4, -0.13, 4, 4, -0.13, -4, 4, -0.13, 4]),
    gl.STATIC_DRAW
  )

  const positionAttribute = gl.getAttribLocation(program, 'position')
  const normalAttribute = gl.getAttribLocation(program, 'normal')
  const uniforms = {
    projection: gl.getUniformLocation(program, 'projection'),
    view: gl.getUniformLocation(program, 'view'),
    eye: gl.getUniformLocation(program, 'eye'),
    rotation: gl.getUniformLocation(program, 'rotation'),
    material: gl.getUniformLocation(program, 'material'),
    hasTexture: gl.getUniformLocation(program, 'hasTexture'),
    faceTexture: gl.getUniformLocation(program, 'faceTexture'),
  }
  const shadowPosition = gl.getAttribLocation(shadowProgram, 'position')
  const shadowProjection = gl.getUniformLocation(shadowProgram, 'projection')
  const shadowView = gl.getUniformLocation(shadowProgram, 'view')
  let angle = -initialIndex * NOTCH
  let target = angle
  let velocity = 0
  let selected = initialIndex
  let dragging = false
  let pointerAngle = 0
  let pointerTime = 0
  let frame = 0
  let lastTime = 0
  let visible = true
  let lost = false
  let disposed = false

  const selectMoment = () => {
    const index = ((Math.round(-angle / NOTCH) % 3) + 3) % 3
    if (selected === index) return
    selected = index
    onSelect(index)
  }

  const draw = () => {
    if (lost || disposed) return
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(shadowProgram)
    gl.uniformMatrix4fv(shadowProjection, false, projection)
    gl.uniformMatrix4fv(shadowView, false, view)
    gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuffer)
    gl.enableVertexAttribArray(shadowPosition)
    gl.vertexAttribPointer(shadowPosition, 3, gl.FLOAT, false, 12, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.disableVertexAttribArray(shadowPosition)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.BLEND)
    gl.useProgram(program)
    gl.uniformMatrix4fv(uniforms.projection, false, projection)
    gl.uniformMatrix4fv(uniforms.view, false, view)
    gl.uniform3fv(uniforms.eye, eye)
    gl.uniform1i(uniforms.faceTexture, 0)

    for (const mesh of meshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer)
      gl.enableVertexAttribArray(positionAttribute)
      gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 24, 0)
      gl.enableVertexAttribArray(normalAttribute)
      gl.vertexAttribPointer(normalAttribute, 3, gl.FLOAT, false, 24, 12)
      gl.uniform1f(uniforms.rotation, mesh.rotating ? angle : 0)
      gl.uniform1f(uniforms.material, mesh.material)
      gl.uniform1i(uniforms.hasTexture, mesh.texture ? 1 : 0)
      gl.bindTexture(gl.TEXTURE_2D, mesh.texture)
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count)
    }
    gl.disableVertexAttribArray(positionAttribute)
    gl.disableVertexAttribArray(normalAttribute)

    onFrame?.({
      progress: -angle / NOTCH,
      x: cssWidth / 2,
      y: cssHeight / 2 - ((view[5] * 0.17 + view[13]) * projection[5] * cssHeight) / 2,
      width: 1.465 * projection[0] * cssWidth,
      height: 1.465 * Math.abs(view[9]) * projection[5] * cssHeight,
      dialWidth: 2.14 * projection[0] * cssWidth,
      dialHeight: 2.14 * Math.abs(view[9]) * projection[5] * cssHeight + 24,
    })
  }

  const tick = (now: number) => {
    frame = 0
    if (!visible || document.hidden || lost || disposed) return
    const delta = Math.min(0.032, lastTime ? (now - lastTime) / 1000 : 1 / 60)
    lastTime = now

    if (!dragging) {
      velocity += ((target - angle) * 125 - velocity * 20) * delta
      angle += velocity * delta
      if (Math.abs(target - angle) < 0.0007 && Math.abs(velocity) < 0.004) {
        angle = target
        velocity = 0
        selectMoment()
      }
    }

    draw()
    if (!dragging && (angle !== target || velocity !== 0)) frame = requestAnimationFrame(tick)
  }

  const requestDraw = () => {
    if (frame || !visible || document.hidden || lost || disposed) return
    lastTime = 0
    frame = requestAnimationFrame(tick)
  }

  const resize = new ResizeObserver((entries) => {
    const bounds = entries[0]?.contentRect
    if (!bounds) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(bounds.width * dpr))
    canvas.height = Math.max(1, Math.round(bounds.height * dpr))
    cssWidth = bounds.width
    cssHeight = bounds.height
    const mobile = bounds.width < 560
    eye[1] = mobile ? 10.8 : 4.5
    view = cameraView(eye)
    const aspect = bounds.width / Math.max(1, bounds.height)
    const vertical = Math.max(mobile ? 1.9 : 1.3, 2.25 / aspect)
    projection = ortho(-vertical * aspect, vertical * aspect, -vertical, vertical, 0.1, 30)
    requestDraw()
  })
  resize.observe(canvas)

  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? true
      if (visible) requestDraw()
      else {
        cancelAnimationFrame(frame)
        frame = 0
      }
    },
    { threshold: 0.01 }
  )
  observer.observe(canvas)

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      frame = 0
    } else requestDraw()
  }
  const onMotion = () => {
    if (reducedMotion.matches) {
      angle = target
      velocity = 0
      selectMoment()
    }
    requestDraw()
  }
  const onLost = (event: Event) => {
    event.preventDefault()
    lost = true
    cancelAnimationFrame(frame)
    frame = 0
    onReady(false)
  }
  document.addEventListener('visibilitychange', onVisibility)
  reducedMotion.addEventListener('change', onMotion)
  canvas.addEventListener('webglcontextlost', onLost)
  onReady(true)
  requestDraw()

  return {
    begin(value) {
      dragging = true
      pointerAngle = value
      pointerTime = performance.now()
      velocity = 0
    },
    drag(value) {
      if (!dragging) return
      let difference = value - pointerAngle
      if (difference > Math.PI) difference -= TAU
      if (difference < -Math.PI) difference += TAU
      const now = performance.now()
      const delta = Math.max(0.008, (now - pointerTime) / 1000)
      pointerAngle = value
      pointerTime = now
      angle += difference
      target = angle
      velocity = velocity * 0.55 + Math.max(-7, Math.min(7, difference / delta)) * 0.45
      requestDraw()
    },
    release() {
      if (!dragging) return
      dragging = false
      const inertia = performance.now() - pointerTime < 90 ? velocity / 8 : 0
      target = Math.round((angle + inertia) / NOTCH) * NOTCH
      if (reducedMotion.matches) {
        angle = target
        velocity = 0
        selectMoment()
      }
      requestDraw()
    },
    select(index) {
      dragging = false
      const next = -index * NOTCH
      target = angle + Math.atan2(Math.sin(next - angle), Math.cos(next - angle))
      angle = target
      velocity = 0
      selectMoment()
      requestDraw()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reducedMotion.removeEventListener('change', onMotion)
      canvas.removeEventListener('webglcontextlost', onLost)
      for (const mesh of meshes) gl.deleteBuffer(mesh.buffer)
      for (const value of textures) gl.deleteTexture(value)
      gl.deleteBuffer(shadowBuffer)
      gl.deleteProgram(program)
      gl.deleteProgram(shadowProgram)
    },
  }
}
