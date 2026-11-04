type RibbonRenderer = {
  point: (x: number, y: number) => void
  begin: () => number
  drag: (value: number) => void
  release: () => boolean
  toggle: () => boolean
  dispose: () => void
}

const ribbonVertex = `
precision highp float;

attribute float path;
attribute vec2 section;
attribute vec2 sectionNormal;
uniform mat4 projection;
uniform mat4 view;
uniform float progress;
uniform float widthScale;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying float edge;
varying float along;

vec3 bezier(vec3 a, vec3 b, vec3 c, vec3 d, float t) {
  float s = 1.0 - t;
  return s * s * s * a + 3.0 * s * s * t * b + 3.0 * s * t * t * c + t * t * t * d;
}

vec3 curve(float t) {
  float vertical = mix(1.22, 1.0, smoothstep(0.72, 1.0, widthScale));
  float segment = (t + 3.14159265) / 6.28318530 * 3.0;
  vec3 folded;
  if (segment < 1.0) {
    folded = bezier(vec3(-3.4, -0.65, 0.3), vec3(-2.0, 0.1, -0.4), vec3(-0.5, 1.2, -0.6), vec3(1.2, 0.95, -0.5), segment);
  } else if (segment < 2.0) {
    folded = bezier(vec3(1.2, 0.95, -0.5), vec3(2.9, 0.7, -0.4), vec3(3.1, -0.9, 0.7), vec3(1.5, -0.78, 1.0), segment - 1.0);
  } else {
    folded = bezier(vec3(1.5, -0.78, 1.0), vec3(-0.1, -0.66, 1.3), vec3(-0.3, 0.1, 0.75), vec3(0.9, 0.48, 0.05), segment - 2.0);
  }
  folded *= vec3(1.12 * widthScale, 0.74 * vertical, 1.0);
  vec3 opened = vec3(t * 1.18 * widthScale, 0.62 * sin(t * 1.35) * vertical, 0.46 * cos(t * 0.8));
  return mix(folded, opened, progress);
}

mat3 ribbonFrame(float t) {
  vec3 tangent = normalize(curve(t + 0.006) - curve(t - 0.006));
  vec3 axis = normalize(cross(tangent, vec3(0.0, 0.0, 1.0)));
  vec3 binormal = cross(tangent, axis);
  float u = (t + 3.14159265) / 6.28318530;
  float twist = mix(-0.2 + u * 2.9 + 0.15 * sin(u * 3.14159265), 0.86 * sin(t * 0.8), progress);
  return mat3(
    axis * cos(twist) + binormal * sin(twist),
    binormal * cos(twist) - axis * sin(twist),
    tangent
  );
}

vec3 ribbonPosition(float t) {
  mat3 frame = ribbonFrame(t);
  return curve(t) + frame[0] * section.x + frame[1] * section.y;
}

void main() {
  mat3 frame = ribbonFrame(path);
  vec3 tangent = normalize(ribbonPosition(path + 0.026) - ribbonPosition(path - 0.026));
  vec3 crossTangent = frame[0] * -sectionNormal.y + frame[1] * sectionNormal.x;
  worldPosition = ribbonPosition(path);
  bool cap = length(sectionNormal) < 0.001;
  worldNormal = cap ? sign(path) * frame[2] : normalize(cross(crossTangent, tangent));
  edge = cap ? 1.0 : abs(sectionNormal.x);
  along = path;
  gl_Position = projection * view * vec4(worldPosition, 1.0);
}
`

const ribbonFragment = `
precision highp float;

uniform vec3 eye;
uniform vec2 lightPoint;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying float edge;
varying float along;

vec3 environment(vec3 direction) {
  vec3 color = mix(vec3(0.78, 0.82, 0.88), vec3(0.99, 0.995, 1.0), smoothstep(-0.7, 0.7, direction.y));
  float softbox = exp(-pow((direction.x + 0.44) / 0.16, 4.0)) * smoothstep(-0.1, 0.5, direction.y);
  color += vec3(1.15, 1.17, 1.2) * softbox;
  float darkFlag = exp(-pow((direction.x - 0.49) / 0.048, 2.0));
  color = mix(color, vec3(0.025, 0.035, 0.055), darkFlag * 0.95);
  float lowerFlag = exp(-pow((direction.z - 0.38) / 0.058, 2.0));
  color = mix(color, vec3(0.055, 0.075, 0.105), lowerFlag * 0.7);
  float strip = exp(-pow((direction.z + 0.28) / 0.035, 2.0));
  color += vec3(1.35) * strip;
  return color;
}

void main() {
  vec3 normal = normalize(worldNormal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 viewDirection = normalize(eye - worldPosition);
  float facing = clamp(dot(normal, viewDirection), 0.0, 1.0);
  float fresnel = 0.043 + 0.957 * pow(1.0 - facing, 4.7);
  vec3 reflection = environment(reflect(-viewDirection, normal));

  vec3 lightDirection = normalize(vec3(-1.8 + lightPoint.x * 2.2, 3.2 + lightPoint.y, 4.0));
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float highlight = pow(max(dot(normal, halfVector), 0.0), 175.0);
  float cut = pow(edge, 2.6);
  float blueAccent = smoothstep(0.72, 0.98, sin(along + 0.4));

  vec3 glass = mix(vec3(0.965, 0.975, 0.99), reflection, 0.75 + fresnel * 0.25);
  glass = mix(glass, vec3(0.035, 0.29, 0.76), cut * (0.12 + blueAccent * 0.72));
  glass += vec3(1.8) * highlight;

  float alpha = 0.31 + fresnel * 0.5 + cut * 0.08;
  alpha = min(0.9, alpha + highlight * 0.2);
  gl_FragColor = vec4(glass, alpha);
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
uniform float progress;
uniform float widthScale;
varying vec2 floorPosition;
void main() {
  vec2 p = floorPosition / vec2(mix(3.0, 3.7, progress) * widthScale, 0.8);
  float shadow = exp(-dot(p, p) * 2.2);
  float contact = exp(-dot(p * vec2(1.1, 1.8), p * vec2(1.1, 1.8)) * 3.0);
  gl_FragColor = vec4(0.25, 0.29, 0.35, shadow * 0.12 + contact * 0.045);
}
`

const PATH_SEGMENTS = 240
const CROSS_SEGMENTS = 32
const CHUNKS = 40
const SEGMENTS_PER_CHUNK = PATH_SEGMENTS / CHUNKS
const INDICES_PER_CHUNK = SEGMENTS_PER_CHUNK * CROSS_SEGMENTS * 6
const SIDE_INDICES = PATH_SEGMENTS * CROSS_SEGMENTS * 6
const EYE: [number, number, number] = [0, 2.15, 8.4]

function compile(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string) {
  const vertex = gl.createShader(gl.VERTEX_SHADER)
  const fragment = gl.createShader(gl.FRAGMENT_SHADER)
  const program = gl.createProgram()

  if (!vertex || !fragment || !program) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    if (program) gl.deleteProgram(program)
    return null
  }

  gl.shaderSource(vertex, vertexSource)
  gl.shaderSource(fragment, fragmentSource)
  gl.compileShader(vertex)
  gl.compileShader(fragment)

  if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS) || !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    gl.deleteProgram(program)
    return null
  }

  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  return program
}

function mesh() {
  const sideVertices = (PATH_SEGMENTS + 1) * CROSS_SEGMENTS
  const vertices = new Float32Array((sideVertices + 2 * (CROSS_SEGMENTS + 1)) * 5)
  const indices = new Uint16Array(SIDE_INDICES + 2 * CROSS_SEGMENTS * 3)
  let vertexOffset = 0
  let indexOffset = 0

  for (let row = 0; row <= PATH_SEGMENTS; row += 1) {
    const path = -Math.PI + (row / PATH_SEGMENTS) * Math.PI * 2

    for (let point = 0; point < CROSS_SEGMENTS; point += 1) {
      const corner = Math.floor(point / 8)
      const angle = (corner * Math.PI) / 2 + ((point % 8) / 7) * (Math.PI / 2)
      const normalX = Math.cos(angle)
      const normalY = Math.sin(angle)
      const cornerX = corner === 0 || corner === 3 ? 0.37 : -0.37
      const cornerY = corner < 2 ? 0.027 : -0.027

      vertices[vertexOffset++] = path
      vertices[vertexOffset++] = cornerX + normalX * 0.061
      vertices[vertexOffset++] = cornerY + normalY * 0.061
      vertices[vertexOffset++] = normalX
      vertices[vertexOffset++] = normalY
    }
  }

  for (let row = 0; row < PATH_SEGMENTS; row += 1) {
    for (let point = 0; point < CROSS_SEGMENTS; point += 1) {
      const next = (point + 1) % CROSS_SEGMENTS
      const a = row * CROSS_SEGMENTS + point
      const b = row * CROSS_SEGMENTS + next
      const c = (row + 1) * CROSS_SEGMENTS + point
      const d = (row + 1) * CROSS_SEGMENTS + next

      indices[indexOffset++] = a
      indices[indexOffset++] = b
      indices[indexOffset++] = c
      indices[indexOffset++] = b
      indices[indexOffset++] = d
      indices[indexOffset++] = c
    }
  }

  for (let cap = 0; cap < 2; cap += 1) {
    const center = sideVertices + cap * (CROSS_SEGMENTS + 1)
    const path = cap === 0 ? -Math.PI : Math.PI
    const source = cap === 0 ? 0 : PATH_SEGMENTS * CROSS_SEGMENTS * 5

    vertices[vertexOffset++] = path
    vertices[vertexOffset++] = 0
    vertices[vertexOffset++] = 0
    vertices[vertexOffset++] = 0
    vertices[vertexOffset++] = 0

    for (let point = 0; point < CROSS_SEGMENTS; point += 1) {
      vertices[vertexOffset++] = path
      vertices[vertexOffset++] = vertices[source + point * 5 + 1]
      vertices[vertexOffset++] = vertices[source + point * 5 + 2]
      vertices[vertexOffset++] = 0
      vertices[vertexOffset++] = 0

      const current = center + 1 + point
      const next = center + 1 + ((point + 1) % CROSS_SEGMENTS)
      indices[indexOffset++] = center
      indices[indexOffset++] = cap === 0 ? next : current
      indices[indexOffset++] = cap === 0 ? current : next
    }
  }

  return { vertices, indices }
}

function viewMatrix() {
  const length = Math.hypot(EYE[1], EYE[2])
  const y = EYE[1] / length
  const z = EYE[2] / length

  return new Float32Array([1, 0, 0, 0, 0, z, y, 0, 0, -y, z, 0, 0, 0, -length, 1])
}

function projectionMatrix(aspect: number, widthScale: number) {
  const height = Math.max(3.3, (8.6 * widthScale) / aspect)
  const width = height * aspect

  return new Float32Array([2 / width, 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, -2 / 30, 0, 0, 0.12, -1, 1])
}

const FOLDED_CURVE = [
  [
    [-3.4, -0.65, 0.3],
    [-2, 0.1, -0.4],
    [-0.5, 1.2, -0.6],
    [1.2, 0.95, -0.5],
  ],
  [
    [1.2, 0.95, -0.5],
    [2.9, 0.7, -0.4],
    [3.1, -0.9, 0.7],
    [1.5, -0.78, 1],
  ],
  [
    [1.5, -0.78, 1],
    [-0.1, -0.66, 1.3],
    [-0.3, 0.1, 0.75],
    [0.9, 0.48, 0.05],
  ],
]

function foldedDepth(t: number, vertical: number) {
  const position = ((t + Math.PI) / (Math.PI * 2)) * 3
  const segment = Math.min(2, Math.floor(position))
  const u = position - segment
  const s = 1 - u
  const weights = [s * s * s, 3 * s * s * u, 3 * s * u * u, u * u * u]
  let y = 0
  let z = 0

  for (let index = 0; index < 4; index += 1) {
    y += FOLDED_CURVE[segment][index][1] * weights[index]
    z += FOLDED_CURVE[segment][index][2] * weights[index]
  }

  return y * 0.74 * vertical * EYE[1] + z * EYE[2]
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

export function createGlassRibbonRenderer(
  canvas: HTMLCanvasElement,
  onReady: (ready: boolean) => void
): RibbonRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
  })

  if (!gl) return null

  const ribbonProgram = compile(gl, ribbonVertex, ribbonFragment)
  const shadowProgram = compile(gl, shadowVertex, shadowFragment)
  const vertexBuffer = gl.createBuffer()
  const indexBuffer = gl.createBuffer()
  const shadowBuffer = gl.createBuffer()

  if (!ribbonProgram || !shadowProgram || !vertexBuffer || !indexBuffer || !shadowBuffer) {
    if (ribbonProgram) gl.deleteProgram(ribbonProgram)
    if (shadowProgram) gl.deleteProgram(shadowProgram)
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer)
    if (indexBuffer) gl.deleteBuffer(indexBuffer)
    if (shadowBuffer) gl.deleteBuffer(shadowBuffer)
    return null
  }

  const geometry = mesh()
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-6, -1.57, -3, 6, -1.57, -3, -6, -1.57, 3, -6, -1.57, 3, 6, -1.57, -3, 6, -1.57, 3]),
    gl.STATIC_DRAW
  )

  const ribbonAttributes = {
    path: gl.getAttribLocation(ribbonProgram, 'path'),
    section: gl.getAttribLocation(ribbonProgram, 'section'),
    normal: gl.getAttribLocation(ribbonProgram, 'sectionNormal'),
  }
  const ribbonUniforms = {
    projection: gl.getUniformLocation(ribbonProgram, 'projection'),
    view: gl.getUniformLocation(ribbonProgram, 'view'),
    progress: gl.getUniformLocation(ribbonProgram, 'progress'),
    widthScale: gl.getUniformLocation(ribbonProgram, 'widthScale'),
    eye: gl.getUniformLocation(ribbonProgram, 'eye'),
    light: gl.getUniformLocation(ribbonProgram, 'lightPoint'),
  }
  const shadowAttribute = gl.getAttribLocation(shadowProgram, 'position')
  const shadowUniforms = {
    projection: gl.getUniformLocation(shadowProgram, 'projection'),
    view: gl.getUniformLocation(shadowProgram, 'view'),
    progress: gl.getUniformLocation(shadowProgram, 'progress'),
    widthScale: gl.getUniformLocation(shadowProgram, 'widthScale'),
  }
  const view = viewMatrix()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const light = { x: 0, y: 0 }
  const targetLight = { x: 0, y: 0 }
  const chunkDepths = Array.from({ length: CHUNKS }, (_, index) => ({ index, depth: 0 }))
  let projection = projectionMatrix(3.4, 1)
  let widthScale = 1
  let progress = 0
  let targetProgress = 0
  let velocity = 0
  let dragging = false
  let previousDragTime = 0
  let frame = 0
  let previousTime = 0
  let visible = true
  let disposed = false
  let contextLost = false

  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.disable(gl.DEPTH_TEST)

  function draw() {
    if (disposed || contextLost) return

    gl?.viewport(0, 0, canvas.width, canvas.height)
    gl?.clearColor(0, 0, 0, 0)
    gl?.clear(gl.COLOR_BUFFER_BIT)
    gl?.disable(gl.CULL_FACE)
    gl?.useProgram(shadowProgram)
    gl?.bindBuffer(gl.ARRAY_BUFFER, shadowBuffer)
    gl?.enableVertexAttribArray(shadowAttribute)
    gl?.vertexAttribPointer(shadowAttribute, 3, gl.FLOAT, false, 0, 0)
    gl?.uniformMatrix4fv(shadowUniforms.projection, false, projection)
    gl?.uniformMatrix4fv(shadowUniforms.view, false, view)
    gl?.uniform1f(shadowUniforms.progress, progress)
    gl?.uniform1f(shadowUniforms.widthScale, widthScale)
    gl?.drawArrays(gl.TRIANGLES, 0, 6)
    gl?.disableVertexAttribArray(shadowAttribute)

    gl?.useProgram(ribbonProgram)
    gl?.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl?.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl?.enableVertexAttribArray(ribbonAttributes.path)
    gl?.enableVertexAttribArray(ribbonAttributes.section)
    gl?.enableVertexAttribArray(ribbonAttributes.normal)
    gl?.vertexAttribPointer(ribbonAttributes.path, 1, gl.FLOAT, false, 20, 0)
    gl?.vertexAttribPointer(ribbonAttributes.section, 2, gl.FLOAT, false, 20, 4)
    gl?.vertexAttribPointer(ribbonAttributes.normal, 2, gl.FLOAT, false, 20, 12)
    gl?.uniformMatrix4fv(ribbonUniforms.projection, false, projection)
    gl?.uniformMatrix4fv(ribbonUniforms.view, false, view)
    gl?.uniform1f(ribbonUniforms.progress, progress)
    gl?.uniform1f(ribbonUniforms.widthScale, widthScale)
    gl?.uniform3f(ribbonUniforms.eye, ...EYE)
    gl?.uniform2f(ribbonUniforms.light, light.x, light.y)

    for (const chunk of chunkDepths) {
      const t = -Math.PI + ((chunk.index + 0.5) / CHUNKS) * Math.PI * 2
      const vertical = widthScale < 1 ? 1.22 : 1
      const openDepth = 0.62 * Math.sin(t * 1.35) * vertical * EYE[1] + 0.46 * Math.cos(t * 0.8) * EYE[2]
      chunk.depth = foldedDepth(t, vertical) * (1 - progress) + openDepth * progress
    }

    chunkDepths.sort((a, b) => a.depth - b.depth)
    gl?.enable(gl.CULL_FACE)

    for (const chunk of chunkDepths) {
      const offset = chunk.index * INDICES_PER_CHUNK * 2
      gl?.cullFace(gl.FRONT)
      gl?.drawElements(gl.TRIANGLES, INDICES_PER_CHUNK, gl.UNSIGNED_SHORT, offset)
      gl?.cullFace(gl.BACK)
      gl?.drawElements(gl.TRIANGLES, INDICES_PER_CHUNK, gl.UNSIGNED_SHORT, offset)
    }

    gl?.disable(gl.CULL_FACE)
    gl?.drawElements(gl.TRIANGLES, CROSS_SEGMENTS * 6, gl.UNSIGNED_SHORT, SIDE_INDICES * 2)

    gl?.disableVertexAttribArray(ribbonAttributes.path)
    gl?.disableVertexAttribArray(ribbonAttributes.section)
    gl?.disableVertexAttribArray(ribbonAttributes.normal)
    gl?.disable(gl.CULL_FACE)
  }

  function animate(time: number) {
    frame = 0
    if (disposed || contextLost || !visible || document.hidden) return

    const delta = Math.min(Math.max((time - previousTime) / 1000, 0.001), 0.035)
    previousTime = time

    if (reducedMotion.matches) {
      progress = targetProgress
      velocity = 0
      light.x = targetLight.x
      light.y = targetLight.y
    } else {
      if (!dragging) {
        velocity += (targetProgress - progress) * 200 * delta
        velocity *= Math.exp(-25 * delta)
        progress = clamp(progress + velocity * delta)
      }

      const ease = 1 - Math.exp(-14 * delta)
      light.x += (targetLight.x - light.x) * ease
      light.y += (targetLight.y - light.y) * ease
    }

    const moving =
      (!dragging && (Math.abs(targetProgress - progress) > 0.0005 || Math.abs(velocity) > 0.002)) ||
      Math.abs(targetLight.x - light.x) + Math.abs(targetLight.y - light.y) > 0.001

    if (!moving && !dragging) progress = targetProgress
    draw()
    if (moving) frame = requestAnimationFrame(animate)
  }

  function requestDraw() {
    if (frame || disposed || contextLost || !visible || document.hidden) return
    previousTime = performance.now() - 16
    frame = requestAnimationFrame(animate)
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1.75), 2, 2400 / Math.max(bounds.width, 1))
    canvas.width = Math.max(1, Math.round(bounds.width * ratio))
    canvas.height = Math.max(1, Math.round(bounds.height * ratio))
    widthScale = bounds.width < 600 ? 0.72 : 1
    projection = projectionMatrix(Math.max(bounds.width, 1) / Math.max(bounds.height, 1), widthScale)
    requestDraw()
  }

  function visibilityChange() {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      frame = 0
    } else {
      requestDraw()
    }
  }

  function loseContext(event: Event) {
    event.preventDefault()
    contextLost = true
    cancelAnimationFrame(frame)
    frame = 0
    onReady(false)
  }

  const resizeObserver = new ResizeObserver(resize)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting

    if (visible) {
      requestDraw()
    } else {
      cancelAnimationFrame(frame)
      frame = 0
    }
  })

  resizeObserver.observe(canvas)
  intersection.observe(canvas)
  document.addEventListener('visibilitychange', visibilityChange)
  reducedMotion.addEventListener('change', requestDraw)
  canvas.addEventListener('webglcontextlost', loseContext)
  resize()
  draw()
  onReady(true)

  return {
    point(x, y) {
      if (reducedMotion.matches) return
      targetLight.x = x
      targetLight.y = y
      requestDraw()
    },
    begin() {
      dragging = true
      velocity = 0
      previousDragTime = performance.now()
      return progress
    },
    drag(value) {
      const next = clamp(value)
      const time = performance.now()
      const delta = Math.max(0.016, (time - previousDragTime) / 1000)
      velocity = (next - progress) / delta
      progress = next
      targetProgress = next
      previousDragTime = time
      requestDraw()
    },
    release() {
      dragging = false
      targetProgress = clamp(progress + velocity * 0.06) > 0.5 ? 1 : 0
      requestDraw()
      return targetProgress === 1
    },
    toggle() {
      dragging = false
      targetProgress = targetProgress > 0.5 ? 0 : 1
      requestDraw()
      return targetProgress === 1
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', visibilityChange)
      reducedMotion.removeEventListener('change', requestDraw)
      canvas.removeEventListener('webglcontextlost', loseContext)
      gl.deleteBuffer(vertexBuffer)
      gl.deleteBuffer(indexBuffer)
      gl.deleteBuffer(shadowBuffer)
      gl.deleteProgram(ribbonProgram)
      gl.deleteProgram(shadowProgram)
    },
  }
}
