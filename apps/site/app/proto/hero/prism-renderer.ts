type PrismRenderer = {
  point: (x: number, y: number) => void
  turn: () => void
  dispose: () => void
}

const vertexSource = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const fragmentSource = `
precision highp float;

uniform vec2 resolution;
uniform vec2 pointer;
uniform float orbit;

const vec3 PAPER = vec3(0.9647, 0.9608, 0.9451);
const int LEAVES = 7;

mat3 rotateY(float a) {
  float s = sin(a), c = cos(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 rotateZ(float a) {
  float s = sin(a), c = cos(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}

vec3 leafCenter(float i) {
  float f = i - 3.0;
  float angle = f * -0.19 + 0.10;
  return rotateZ(angle) * vec3(0.0, 0.86, 0.0) + vec3(0.0, -0.64, f * -0.19);
}

mat3 leafRotation(float i) {
  float f = i - 3.0;
  return rotateY(f * 0.10 - 0.12) * rotateZ(f * -0.19 + 0.10);
}

float roundedBox(vec3 p, vec3 size, float radius) {
  vec3 q = abs(p) - size + radius;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - radius;
}

vec2 hitBounds(vec3 ro, vec3 rd, vec3 size) {
  vec3 inv = 1.0 / rd;
  vec3 n = inv * ro;
  vec3 k = abs(inv) * size;
  vec3 t1 = -n - k;
  vec3 t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}

float hitLeaf(vec3 ro, vec3 rd, float index) {
  mat3 rotation = leafRotation(index);
  vec3 localOrigin = (ro - leafCenter(index)) * rotation;
  vec3 localDirection = rd * rotation;
  vec3 size = vec3(0.79, 1.45, 0.12);
  vec2 bounds = hitBounds(localOrigin, localDirection, size);
  if (bounds.x > bounds.y || bounds.y < 0.0) return 1000.0;

  float t = max(0.0, bounds.x);
  for (int step = 0; step < 64; step++) {
    float distance = roundedBox(localOrigin + localDirection * t, size, 0.09);
    if (distance < 0.001) return t;
    t += distance;
    if (t > bounds.y) break;
  }
  return 1000.0;
}

vec3 normalAt(vec3 p) {
  vec3 size = vec3(0.79, 1.45, 0.12);
  vec2 epsilon = vec2(0.001, 0.0);
  return normalize(vec3(
    roundedBox(p + epsilon.xyy, size, 0.09) - roundedBox(p - epsilon.xyy, size, 0.09),
    roundedBox(p + epsilon.yxy, size, 0.09) - roundedBox(p - epsilon.yxy, size, 0.09),
    roundedBox(p + epsilon.yyx, size, 0.09) - roundedBox(p - epsilon.yyx, size, 0.09)
  ));
}

vec3 studio(vec3 direction) {
  vec3 color = mix(vec3(0.18, 0.23, 0.32), vec3(1.0, 0.995, 0.97), smoothstep(-0.4, 0.65, direction.y));
  float window = pow(max(dot(direction, normalize(vec3(-0.8, 1.2, 1.0))), 0.0), 7.0);
  color += vec3(1.1, 1.06, 0.98) * window;

  float blueStrip = exp(-pow((direction.x - 0.48) / 0.12, 2.0));
  blueStrip *= smoothstep(-0.4, 0.5, direction.y);
  color = mix(color, vec3(0.025, 0.19, 0.92) * 1.2, blueStrip * 0.86);

  float darkStrip = exp(-pow((direction.x + 0.1) / 0.05, 2.0));
  color = mix(color, vec3(0.065, 0.083, 0.11), darkStrip * 0.6);
  float stripLight = exp(-pow((direction.x + 0.38) / 0.022, 2.0));
  color += vec3(1.8, 1.8, 1.76) * stripLight;
  return color;
}

vec3 backdrop(vec3 origin, vec3 direction) {
  vec3 color = PAPER;
  float floorT = (-1.63 - origin.y) / direction.y;
  if (floorT > 0.0) {
    vec3 p = origin + direction * floorT;
    float shadow = exp(-dot(p.xz / vec2(1.6, 1.05), p.xz / vec2(1.6, 1.05)) * 1.3);
    float contact = exp(-dot(p.xz / vec2(1.15, 0.61), p.xz / vec2(1.15, 0.61)) * 2.0);
    color *= 1.0 - shadow * 0.13 - contact * 0.13;

    float caustic = exp(-pow((p.x + p.z * 0.36 - 0.3) / 1.8, 2.0));
    caustic *= exp(-pow((p.z - 0.2) / 0.44, 2.0));
    color += vec3(-0.016, 0.002, 0.033) * caustic;
  }
  return color;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - resolution) / resolution.y;
  float angle = 0.48 + orbit + pointer.x * 0.11;
  vec3 origin = vec3(sin(angle) * 7.8, 2.28 + pointer.y * 0.3, cos(angle) * 7.8);
  vec3 target = vec3(0.0, -0.12, 0.0);
  vec3 forward = normalize(target - origin);
  vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, forward);
  vec3 direction = normalize(uv.x * right + uv.y * up + 3.2 * forward);

  vec3 color = vec3(0.0);
  vec3 transmission = vec3(1.0);
  float previousT = 0.0;
  float intersections[LEAVES];
  for (int leaf = 0; leaf < LEAVES; leaf++) {
    intersections[leaf] = hitLeaf(origin, direction, float(leaf));
  }

  for (int layer = 0; layer < LEAVES; layer++) {
    float nearestT = 1000.0;
    float index = -1.0;
    for (int leaf = 0; leaf < LEAVES; leaf++) {
      float t = intersections[leaf];
      if (t > previousT + 0.002 && t < nearestT) {
        nearestT = t;
        index = float(leaf);
      }
    }
    if (index < 0.0) break;

    mat3 rotation = leafRotation(index);
    vec3 point = origin + direction * nearestT;
    vec3 localPoint = (point - leafCenter(index)) * rotation;
    vec3 localNormal = normalAt(localPoint);
    vec3 normal = rotation * localNormal;
    float facing = max(dot(-direction, normal), 0.0);
    float fresnel = 0.045 + 0.955 * pow(1.0 - facing, 5.0);

    vec3 reflection = studio(reflect(direction, normal));
    float edgeDistance = min(0.79 - abs(localPoint.x), 1.45 - abs(localPoint.y));
    float edge = 1.0 - smoothstep(0.004, 0.047, edgeDistance);
    float side = 1.0 - abs(localNormal.z);
    vec3 halfVector = normalize(normalize(vec3(-1.0, 1.8, 1.0)) - direction);
    float rim = pow(max(dot(normal, halfVector), 0.0), 180.0);
    reflection += vec3(1.0, 0.995, 0.98) * rim * 3.0;
    reflection = mix(reflection, vec3(0.012, 0.12, 0.61), side * 0.62);

    float coating = 0.005 + edge * 0.30 + side * 0.12;
    float opacity = min(0.96, fresnel + coating);
    vec3 glass = reflection * fresnel + vec3(0.018, 0.17, 0.64) * coating;
    color += transmission * glass;
    transmission *= (1.0 - opacity) * vec3(0.988, 0.996, 0.999);
    previousT = nearestT;
  }

  color += transmission * backdrop(origin, direction);
  float vignette = smoothstep(0.2, 1.6, length(uv * vec2(0.55, 0.7)));
  color = mix(color, PAPER, vignette * 0.12);
  gl_FragColor = vec4(color, 1.0);
}
`

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)

  if (!shader) return null

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }

  return shader
}

export function createPrismRenderer(
  canvas: HTMLCanvasElement,
  onReady: (ready: boolean) => void
): PrismRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })

  if (!gl) return null

  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()

  if (!vertex || !fragment || !program) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    if (program) gl.deleteProgram(program)
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

  const buffer = gl.createBuffer()

  if (!buffer) {
    gl.deleteProgram(program)
    return null
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  gl.useProgram(program)

  const attribute = gl.getAttribLocation(program, 'position')
  gl.enableVertexAttribArray(attribute)
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)

  const resolution = gl.getUniformLocation(program, 'resolution')
  const pointer = gl.getUniformLocation(program, 'pointer')
  const orbit = gl.getUniformLocation(program, 'orbit')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const current = { x: 0, y: 0, orbit: 0 }
  const target = { x: 0, y: 0, orbit: 0 }
  let frame = 0
  let visible = true
  let disposed = false
  let lost = false
  let lastTime = 0

  function draw() {
    gl?.viewport(0, 0, canvas.width, canvas.height)
    gl?.uniform2f(resolution, canvas.width, canvas.height)
    gl?.uniform2f(pointer, current.x, current.y)
    gl?.uniform1f(orbit, current.orbit)
    gl?.drawArrays(gl.TRIANGLES, 0, 6)
  }

  function animate(time: number) {
    frame = 0
    if (disposed || lost || !visible || document.hidden) return

    const delta = Math.min((time - lastTime) / 1000, 0.05)
    const ease = reducedMotion.matches ? 1 : 1 - Math.exp(-delta * 9)
    lastTime = time
    current.x += (target.x - current.x) * ease
    current.y += (target.y - current.y) * ease
    current.orbit += (target.orbit - current.orbit) * ease
    draw()

    const remaining =
      Math.abs(target.x - current.x) + Math.abs(target.y - current.y) + Math.abs(target.orbit - current.orbit)
    if (remaining > 0.001) frame = requestAnimationFrame(animate)
  }

  function requestDraw() {
    if (frame || disposed || lost || !visible || document.hidden) return
    lastTime = performance.now() - 16
    frame = requestAnimationFrame(animate)
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1.75), 2, 1600 / Math.max(bounds.width, 1))
    canvas.width = Math.max(1, Math.round(bounds.width * ratio))
    canvas.height = Math.max(1, Math.round(bounds.height * ratio))
    requestDraw()
  }

  function handleVisibility() {
    if (document.hidden) cancelAnimationFrame(frame)
    frame = 0
    requestDraw()
  }

  function handleContextLost(event: Event) {
    event.preventDefault()
    lost = true
    cancelAnimationFrame(frame)
    frame = 0
    onReady(false)
  }

  const observer = new ResizeObserver(resize)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (!visible) {
      cancelAnimationFrame(frame)
      frame = 0
    } else {
      requestDraw()
    }
  })

  observer.observe(canvas)
  intersection.observe(canvas)
  document.addEventListener('visibilitychange', handleVisibility)
  reducedMotion.addEventListener('change', requestDraw)
  canvas.addEventListener('webglcontextlost', handleContextLost)
  resize()
  draw()
  onReady(true)

  return {
    point(x, y) {
      if (reducedMotion.matches) return
      target.x = x
      target.y = y
      requestDraw()
    },
    turn() {
      target.orbit += Math.PI * 0.5
      requestDraw()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', handleVisibility)
      reducedMotion.removeEventListener('change', requestDraw)
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    },
  }
}
