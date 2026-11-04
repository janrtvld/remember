export type AfdrukRecord = { lines: [string, string]; source: string; detail: string }

type Point = { x: number; z: number }
type Painter = { draw: (values: Float32Array, width: number, height: number) => void; dispose: () => void }

const columns = 58
const rows = 23
const count = columns * rows
const pitch = 0.17
const yaw = -0.13
const tilt = 0.68
const cy = Math.cos(yaw)
const sy = Math.sin(yaw)
const ct = Math.cos(tilt)
const st = Math.sin(tilt)
const positions = Array.from({ length: count }, (_, index) => ({
  x: ((index % columns) - (columns - 1) / 2) * pitch,
  z: (Math.floor(index / columns) - (rows - 1) / 2) * pitch,
}))

function scaleFor(width: number, height: number) {
  return Math.min(width / 11.2, height / 5.2)
}

function project(x: number, y: number, z: number, width: number, height: number) {
  const scale = scaleFor(width, height)
  return {
    x: width / 2 + (cy * x - sy * z) * scale,
    y: height * 0.47 - (ct * y - st * (sy * x + cy * z)) * scale,
  }
}

const letters: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
}

function momentImpression(record: AfdrukRecord): Float32Array {
  const values = new Float32Array(count)

  record.lines.forEach((line, lineIndex) => {
    const firstColumn = Math.floor((columns - (line.length * 6 - 1)) / 2)
    const firstRow = 3 + lineIndex * 10

    Array.from(line).forEach((letter, letterIndex) => {
      letters[letter]?.forEach((pixels, y) => {
        Array.from(pixels).forEach((pixel, x) => {
          const column = firstColumn + letterIndex * 6 + x
          if (pixel === '1' && column >= 0 && column < columns) {
            values[(firstRow + y) * columns + column] = 1
          }
        })
      })
    })
  })

  return values
}

const vertexSource = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 offset;
attribute float impression;
attribute float shade;
uniform vec2 viewport;
uniform float scale;
uniform float instanced;
varying vec3 world;
varying vec3 surfaceNormal;
varying float mark;
varying float occlusion;

void main() {
  vec3 p = position;
  if (instanced > 0.5) {
    float h = 0.46 + impression * 0.30;
    h += 0.025 * sin(offset.x * 0.75 + offset.y * 0.8);
    p = vec3(position.x + offset.x, 0.09 + position.y * h, position.z + offset.y);
  }
  float horizontal = ${cy.toFixed(8)} * p.x - ${sy.toFixed(8)} * p.z;
  float along = ${sy.toFixed(8)} * p.x + ${cy.toFixed(8)} * p.z;
  float vertical = ${ct.toFixed(8)} * p.y - ${st.toFixed(8)} * along;
  float depth = ${st.toFixed(8)} * p.y + ${ct.toFixed(8)} * along;
  gl_Position = vec4(horizontal * scale * 2.0 / viewport.x, vertical * scale * 2.0 / viewport.y + 0.06, -depth / 20.0, 1.0);
  world = p;
  surfaceNormal = normal;
  mark = impression * instanced;
  occlusion = mix(1.0, shade, instanced);
}
`

const fragmentSource = `
precision highp float;
uniform vec3 material;
uniform float mode;
varying vec3 world;
varying vec3 surfaceNormal;
varying float mark;
varying float occlusion;

void main() {
  if (mode > 1.5) {
    vec2 uv = (world.xz - vec2(0.17, 0.18)) / vec2(5.75, 2.6);
    float alpha = exp(-pow(abs(uv.x), 6.0) * 3.4 - pow(abs(uv.y), 6.0) * 3.4) * 0.13;
    gl_FragColor = vec4(0.18, 0.23, 0.30, alpha);
    return;
  }
  vec3 n = normalize(surfaceNormal);
  vec3 light = normalize(vec3(-0.65, 1.4, 0.85));
  vec3 eye = normalize(vec3(-0.10, 0.63, 0.77));
  vec3 halfVector = normalize(light + eye);
  float diffuse = clamp(dot(n, light), 0.0, 1.0);
  float specular = pow(clamp(dot(n, halfVector), 0.0, 1.0), 52.0);
  float top = smoothstep(0.40, 0.98, n.y);
  float blue = smoothstep(0.04, 0.60, mark) * top * 0.98;
  vec3 base = mix(material, vec3(0.075, 0.30, 0.82), blue);
  // The algebraic angular reflection stays finite on horizontal cap normals.
  float horizontalLength = max(dot(n.xz, n.xz), 0.0001);
  float steel = (2.0 * n.x * n.z * 0.87758 + (n.x * n.x - n.z * n.z) * 0.47943) / horizontalLength * 0.065;
  float lighting = 0.57 + diffuse * 0.43 + steel * (1.0 - top);
  vec3 color = base * lighting * occlusion;
  color += specular * mix(0.30, 0.14, blue);
  color += pow(1.0 - clamp(dot(n, eye), 0.0, 1.0), 3.0) * 0.085;
  color *= 1.0 - (1.0 - top) * 0.055;
  gl_FragColor = vec4(color, 1.0);
}
`

function createProgram(gl: WebGLRenderingContext) {
  const program = gl.createProgram()
  if (!program) return null

  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) {
      gl.deleteProgram(program)
      return null
    }
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      gl.deleteProgram(program)
      return null
    }
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  }

  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

function cylinderMesh() {
  const vertices: number[] = []
  const steps = 12
  const radius = 0.071
  const capRadius = 0.065
  const vertex = (angle: number, y: number, r: number, top: number) => {
    vertices.push(Math.cos(angle) * r, y, Math.sin(angle) * r)
    vertices.push(Math.cos(angle) * (1 - top), top, Math.sin(angle) * (1 - top))
  }

  for (let index = 0; index < steps; index++) {
    const a = (index / steps) * Math.PI * 2
    const b = ((index + 1) / steps) * Math.PI * 2
    vertex(a, 0, radius, 0)
    vertex(b, 0, radius, 0)
    vertex(a, 0.97, radius, 0)
    vertex(b, 0, radius, 0)
    vertex(b, 0.97, radius, 0)
    vertex(a, 0.97, radius, 0)
    vertex(a, 0.97, radius, 0.6)
    vertex(b, 0.97, radius, 0.6)
    vertex(a, 1, capRadius, 0.6)
    vertex(b, 0.97, radius, 0.6)
    vertex(b, 1, capRadius, 0.6)
    vertex(a, 1, capRadius, 0.6)
    vertices.push(0, 1, 0, 0, 1, 0)
    vertex(a, 1, capRadius, 1)
    vertex(b, 1, capRadius, 1)
  }

  return new Float32Array(vertices)
}

function slabMesh(width: number, depth: number, bottom: number, top: number, radius: number) {
  const vertices: number[] = []
  const outline: Point[] = []
  const corners = [
    { x: width / 2 - radius, z: depth / 2 - radius, angle: 0 },
    { x: -width / 2 + radius, z: depth / 2 - radius, angle: Math.PI / 2 },
    { x: -width / 2 + radius, z: -depth / 2 + radius, angle: Math.PI },
    { x: width / 2 - radius, z: -depth / 2 + radius, angle: Math.PI * 1.5 },
  ]

  for (const corner of corners) {
    for (let step = 0; step <= 6; step++) {
      const angle = corner.angle + (step / 6) * Math.PI * 0.5
      outline.push({ x: corner.x + Math.cos(angle) * radius, z: corner.z + Math.sin(angle) * radius })
    }
  }

  for (let index = 0; index < outline.length; index++) {
    const a = outline[index]
    const b = outline[(index + 1) % outline.length]
    vertices.push(0, top, 0, 0, 1, 0, a.x, top, a.z, 0, 1, 0, b.x, top, b.z, 0, 1, 0)
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    const nx = (b.z - a.z) / length
    const nz = (a.x - b.x) / length
    vertices.push(a.x, bottom, a.z, nx, 0, nz, b.x, bottom, b.z, nx, 0, nz, a.x, top, a.z, nx, 0, nz)
    vertices.push(b.x, bottom, b.z, nx, 0, nz, b.x, top, b.z, nx, 0, nz, a.x, top, a.z, nx, 0, nz)
  }

  return new Float32Array(vertices)
}

function shiftedSlab(width: number, depth: number, bottom: number, top: number, radius: number, z: number) {
  const mesh = slabMesh(width, depth, bottom, top, radius)
  for (let index = 2; index < mesh.length; index += 6) mesh[index] += z
  return mesh
}

function createGpuPainter(canvas: HTMLCanvasElement): Painter | null {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' })
  if (!gl) return null
  const extension = gl.getExtension('ANGLE_instanced_arrays')
  if (!extension) return null
  const program = createProgram(gl)
  if (!program) return null

  const meshes = [
    shiftedSlab(11.5, 6.8, -0.24, -0.24, 0.5, 0.7),
    shiftedSlab(10.22, 5.6, -0.15, 0.04, 0.19, 0.74),
    slabMesh(10.01, 3.94, 0.04, 0.075, 0.12),
    cylinderMesh(),
  ]
  const buffers = meshes.map((mesh) => {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW)
    return buffer
  })
  const instanceBuffer = gl.createBuffer()
  if (buffers.some((buffer) => !buffer) || !instanceBuffer) {
    for (const buffer of buffers) if (buffer) gl.deleteBuffer(buffer)
    if (instanceBuffer) gl.deleteBuffer(instanceBuffer)
    gl.deleteProgram(program)
    return null
  }

  const instanceData = new Float32Array(count * 4)
  const attributes = {
    position: gl.getAttribLocation(program, 'position'),
    normal: gl.getAttribLocation(program, 'normal'),
    offset: gl.getAttribLocation(program, 'offset'),
    impression: gl.getAttribLocation(program, 'impression'),
    shade: gl.getAttribLocation(program, 'shade'),
  }
  const uniforms = {
    viewport: gl.getUniformLocation(program, 'viewport'),
    scale: gl.getUniformLocation(program, 'scale'),
    instanced: gl.getUniformLocation(program, 'instanced'),
    material: gl.getUniformLocation(program, 'material'),
    mode: gl.getUniformLocation(program, 'mode'),
  }

  return {
    draw(values, width, height) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.useProgram(program)
      gl.enable(gl.DEPTH_TEST)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.CULL_FACE)
      gl.uniform2f(uniforms.viewport, width, height)
      gl.uniform1f(uniforms.scale, scaleFor(width, height))

      for (const attribute of [attributes.offset, attributes.impression, attributes.shade]) {
        extension.vertexAttribDivisorANGLE(attribute, 0)
        gl.disableVertexAttribArray(attribute)
      }
      gl.vertexAttrib2f(attributes.offset, 0, 0)
      gl.vertexAttrib1f(attributes.impression, 0)
      gl.vertexAttrib1f(attributes.shade, 1)
      gl.uniform1f(uniforms.instanced, 0)

      for (let index = 0; index < meshes.length; index++) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers[index])
        gl.enableVertexAttribArray(attributes.position)
        gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 24, 0)
        gl.enableVertexAttribArray(attributes.normal)
        gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, 24, 12)
        gl.uniform1f(uniforms.mode, index === 0 ? 2 : 0)

        if (index < 3) {
          gl.uniform3f(
            uniforms.material,
            index === 1 ? 0.84 : 0.41,
            index === 1 ? 0.87 : 0.46,
            index === 1 ? 0.91 : 0.52
          )
          gl.drawArrays(gl.TRIANGLES, 0, meshes[index].length / 6)
          continue
        }

        for (let pin = 0; pin < count; pin++) {
          const position = positions[pin]
          const neighbor = (values[Math.max(0, pin - columns)] + values[Math.max(0, pin - 1)]) / 2
          instanceData[pin * 4] = position.x
          instanceData[pin * 4 + 1] = position.z
          instanceData[pin * 4 + 2] = values[pin]
          instanceData[pin * 4 + 3] = 1 - Math.max(0, values[pin] - neighbor) * 0.18
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(attributes.offset)
        gl.vertexAttribPointer(attributes.offset, 2, gl.FLOAT, false, 16, 0)
        gl.enableVertexAttribArray(attributes.impression)
        gl.vertexAttribPointer(attributes.impression, 1, gl.FLOAT, false, 16, 8)
        gl.enableVertexAttribArray(attributes.shade)
        gl.vertexAttribPointer(attributes.shade, 1, gl.FLOAT, false, 16, 12)
        extension.vertexAttribDivisorANGLE(attributes.offset, 1)
        extension.vertexAttribDivisorANGLE(attributes.impression, 1)
        extension.vertexAttribDivisorANGLE(attributes.shade, 1)
        gl.uniform1f(uniforms.instanced, 1)
        gl.uniform3f(uniforms.material, 0.86, 0.9, 0.94)
        extension.drawArraysInstancedANGLE(gl.TRIANGLES, 0, meshes[index].length / 6, count)
      }
    },
    dispose() {
      for (const buffer of buffers) gl.deleteBuffer(buffer)
      gl.deleteBuffer(instanceBuffer)
      gl.deleteProgram(program)
    },
  }
}

function createCanvasPainter(canvas: HTMLCanvasElement): Painter {
  const context = canvas.getContext('2d')
  const order = positions.map((position, index) => ({ index, depth: sy * position.x + cy * position.z }))
  order.sort((a, b) => a.depth - b.depth)

  return {
    draw(values, width, height) {
      if (!context) return
      const ratio = canvas.width / width
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      const scale = scaleFor(width, height)
      const corners = [
        project(-5.1, 0, -2.06, width, height),
        project(5.1, 0, -2.06, width, height),
        project(5.1, 0, 3.54, width, height),
        project(-5.1, 0, 3.54, width, height),
      ]
      context.beginPath()
      corners.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      context.closePath()
      context.fillStyle = '#aab3c0'
      context.shadowColor = 'rgba(30, 41, 59, 0.18)'
      context.shadowBlur = 15
      context.shadowOffsetY = 10
      context.fill()
      context.shadowColor = 'transparent'
      context.strokeStyle = '#d5dce5'
      context.lineWidth = 4
      context.stroke()

      for (const { index } of order) {
        const position = positions[index]
        const mark = values[index]
        const pinHeight = 0.55 + mark * 0.3 + 0.025 * Math.sin(position.x * 0.75 + position.z * 0.8)
        const top = project(position.x, pinHeight, position.z, width, height)
        const base = project(position.x, 0.09, position.z, width, height)
        const radius = 0.071 * scale
        const gradient = context.createLinearGradient(top.x - radius, 0, top.x + radius, 0)
        gradient.addColorStop(0, '#9da9b8')
        gradient.addColorStop(0.32, '#e1e7ee')
        gradient.addColorStop(1, '#8b98a9')
        context.fillStyle = gradient
        context.fillRect(top.x - radius, top.y, radius * 2, Math.max(0, base.y - top.y))
        context.beginPath()
        context.ellipse(top.x, top.y, radius, radius * st, 0, 0, Math.PI * 2)
        context.fillStyle = `rgb(${Math.round(225 - mark * 196)}, ${Math.round(233 - mark * 133)}, ${Math.round(243 - mark * 21)})`
        context.fill()
        context.strokeStyle = `rgba(255,255,255,${0.6 - mark * 0.35})`
        context.lineWidth = 0.5
        context.stroke()
      }
    },
    dispose() {},
  }
}

export function createAfdrukRenderer(
  canvas: HTMLCanvasElement,
  fallback: HTMLCanvasElement,
  engraving: HTMLCanvasElement,
  records: AfdrukRecord[],
  onMode: (mode: string) => void
) {
  const canvasPainter = createCanvasPainter(fallback)
  const gpuPainter = createGpuPainter(canvas)
  let painter = gpuPainter ?? canvasPainter
  onMode(gpuPainter ? 'webgl' : 'canvas')

  const impressions = records.map(momentImpression)
  const engravingContext = engraving.getContext('2d')
  const fontFamily = getComputedStyle(canvas).fontFamily
  let selected = 0
  const initial = impressions[0]
  let target: Float32Array = initial.slice()
  const current = initial.slice()
  const velocity = new Float32Array(count)
  const scrubbed = new Float32Array(count)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let width = 1
  let height = 1
  let frame = 0
  let lastTime = 0
  let visible = true
  let disposed = false

  const draw = () => {
    painter.draw(current, width, height)
    if (!engravingContext) return

    const context = engravingContext
    const ratio = engraving.width / width
    const scale = scaleFor(width, height)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    const origin = project(0, 0.085, 0, width, height)
    context.setTransform(
      (ratio * cy * scale) / 100,
      (ratio * st * sy * scale) / 100,
      (ratio * -sy * scale) / 100,
      (ratio * st * cy * scale) / 100,
      ratio * origin.x,
      ratio * origin.y
    )
    context.textAlign = 'center'
    const record = records[selected]
    const sourceSize = Math.max(0.42, 10.5 / (scale * st)) * 100
    const detailSize = Math.max(0.31, 9 / (scale * st)) * 100
    context.font = `600 ${sourceSize}px ${fontFamily}`
    context.fillStyle = 'rgba(255,255,255,0.72)'
    context.fillText(record.source, 0, 256, 920)
    context.fillStyle = '#455568'
    context.fillText(record.source, 0, 254, 920)
    context.font = `500 ${detailSize}px ${fontFamily}`
    context.fillStyle = '#637185'
    context.fillText(record.detail, 0, 323, 920)
  }

  const tick = (time: number) => {
    frame = 0
    if (disposed || !visible || document.hidden) return
    const delta = Math.min(0.032, lastTime ? (time - lastTime) / 1000 : 1 / 60)
    lastTime = time
    let unsettled = false

    for (let index = 0; index < count; index++) {
      velocity[index] += ((target[index] - current[index]) * 195 - velocity[index] * 25) * delta
      current[index] += velocity[index] * delta
      if (Math.abs(target[index] - current[index]) < 0.0005 && Math.abs(velocity[index]) < 0.002) {
        current[index] = target[index]
        velocity[index] = 0
      } else unsettled = true
    }

    draw()
    if (unsettled) frame = requestAnimationFrame(tick)
  }

  const requestDraw = (immediate = false) => {
    if (disposed) return
    if (immediate || reducedMotion.matches) {
      cancelAnimationFrame(frame)
      frame = 0
      current.set(target)
      velocity.fill(0)
      if (visible && !document.hidden) draw()
      return
    }
    if (!frame && visible && !document.hidden) {
      lastTime = 0
      frame = requestAnimationFrame(tick)
    }
  }

  const resize = () => {
    const bounds = canvas.getBoundingClientRect()
    width = Math.max(bounds.width, 1)
    height = Math.max(bounds.height, 1)
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    for (const element of [canvas, fallback, engraving]) {
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
    }
    requestDraw()
  }

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) requestDraw()
    else {
      cancelAnimationFrame(frame)
      frame = 0
    }
  })
  intersection.observe(canvas)

  const visibilityChange = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      frame = 0
    } else requestDraw()
  }
  const motionChange = () => requestDraw(reducedMotion.matches)
  const contextLost = (event: Event) => {
    event.preventDefault()
    painter = canvasPainter
    onMode('canvas')
    requestDraw()
  }

  document.addEventListener('visibilitychange', visibilityChange)
  reducedMotion.addEventListener('change', motionChange)
  canvas.addEventListener('webglcontextlost', contextLost)
  resize()
  draw()

  return {
    select(index: number, immediate = false) {
      selected = Math.max(0, Math.min(records.length - 1, Math.round(index)))
      target = impressions[selected]
      requestDraw(immediate)
    },
    scrub(position: number) {
      const progress = Math.max(0, Math.min(records.length - 1, position))
      const before = Math.floor(progress)
      const after = Math.min(records.length - 1, before + 1)
      const blend = progress - before
      selected = Math.round(progress)
      if (reducedMotion.matches) {
        target = impressions[selected]
        requestDraw(true)
        return
      }
      target = scrubbed
      for (let index = 0; index < count; index++) {
        target[index] = impressions[before][index] * (1 - blend) + impressions[after][index] * blend
      }
      requestDraw()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', visibilityChange)
      reducedMotion.removeEventListener('change', motionChange)
      canvas.removeEventListener('webglcontextlost', contextLost)
      gpuPainter?.dispose()
      canvasPainter.dispose()
    },
  }
}
