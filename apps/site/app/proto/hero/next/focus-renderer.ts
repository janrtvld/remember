export type FocusTrace = {
  shortTitle: string
  time: string
  lines: readonly [string, string]
  excerpt: string
  sourceLabel: string
  app: string
}

export type FocusRenderer = {
  select: (index: number, animate: boolean) => void
  dispose: () => void
}

const vertexSource = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`

const fragmentSource = `
precision highp float;
uniform vec2 u_resolution;
uniform vec2 u_size;
uniform vec2 u_textureSize;
uniform vec2 u_center;
uniform vec2 u_light;
uniform float u_radius;
uniform float u_fieldOffset;
uniform sampler2D u_base;
uniform sampler2D u_focus;

vec3 scene(vec2 point) {
  return texture2D(u_base, clamp((point + vec2(u_fieldOffset, 0.0)) / u_textureSize, 0.0, 1.0)).rgb;
}

vec3 focused(vec2 point) {
  return texture2D(u_focus, clamp((point + vec2(u_fieldOffset, 0.0)) / u_textureSize, 0.0, 1.0)).rgb;
}

float band(float value, float center, float width) {
  return exp(-pow((value - center) / width, 2.0));
}

vec3 studio(vec3 reflection) {
  float window = smoothstep(0.28, 0.54, reflection.y) * (1.0 - smoothstep(0.8, 1.0, reflection.y));
  float stripe = band(reflection.x + reflection.z * 0.17, -0.35, 0.14);
  float lower = band(reflection.y, -0.68, 0.2);
  return vec3(0.43, 0.46, 0.5) + vec3(window * 0.37 + stripe * 0.23 + lower * 0.16);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) * u_size / u_resolution;
  vec2 delta = pixel - u_center;
  vec2 p = delta / vec2(u_radius, u_radius * 0.9);
  float r = length(p);
  float aa = 1.15 / u_radius;
  vec3 color = scene(pixel);

  // A close surface shadow gives the cut edge its weight without a halo.
  vec2 shadowP = (delta - vec2(5.0, 13.0)) / vec2(u_radius * 1.045, u_radius * 0.91);
  float shadowR = length(shadowP);
  float shadow = exp(-pow(max(shadowR - 0.85, 0.0) / 0.17, 2.0)) * 0.12;
  shadow += exp(-pow((shadowR - 0.965) / 0.055, 2.0)) * 0.1;
  color *= 1.0 - shadow;

  // The rear wall sits slightly below the polished front of the instrument.
  float rear = length((delta - vec2(0.0, 4.2)) / vec2(u_radius, u_radius * 0.9));
  color = mix(color, vec3(0.40, 0.43, 0.48), 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rear));

  if (r < 1.0 + aa) {
    vec2 radial = p / max(r, 0.001);
    float glassRadius = 0.936;
    float glassMask = 1.0 - smoothstep(glassRadius - aa, glassRadius + aa, r);
    float edge = smoothstep(0.67, glassRadius, r);
    float magnification = 0.62 + pow(smoothstep(0.73, glassRadius, r), 3.0) * 0.19;
    vec2 refracted = u_center + delta * magnification;
    vec2 dispersion = radial * pow(edge, 4.0) * 0.8;
    vec3 glass = vec3(focused(refracted + dispersion).r, focused(refracted).g, focused(refracted - dispersion).b);

    // A low convex crown reflects the large studio softbox on its upper shoulder.
    vec3 normal = normalize(vec3(p.x * 0.45, -p.y * 0.45, sqrt(max(0.1, 1.0 - r * r * 0.36))));
    vec3 view = normalize(vec3(u_light * 0.045, 1.0));
    vec3 reflected = reflect(-view, normal);
    float softbox = band(reflected.y - reflected.x * 0.2, 0.46, 0.125);
    softbox *= smoothstep(-0.85, -0.15, p.x) * (1.0 - smoothstep(0.45, 0.85, p.x));
    float reflection = softbox * 0.29;
    glass = mix(glass, vec3(1.0), reflection);
    glass *= 1.0 - pow(edge, 4.0) * 0.085;
    float cut = band(r, 0.907, 0.011);
    float lowerEdge = smoothstep(-0.35, 0.7, p.y);
    glass = mix(glass, vec3(0.18, 0.38, 0.78), cut * (0.22 + lowerEdge * 0.42));
    glass += vec3(0.96, 0.98, 1.0) * band(r, 0.926, 0.008) * 0.3;
    float arc = band(r, 0.86, 0.009) * smoothstep(0.12, 0.55, -p.y) * (1.0 - smoothstep(-0.1, 0.65, p.x));
    glass = mix(glass, vec3(1.0), arc * 0.72);

    // Analytic torus normals produce continuous, crisp machined-metal reflections.
    float bevel = clamp((r - 0.966) / 0.034, -1.0, 1.0);
    vec3 metalNormal = normalize(vec3(radial.x * bevel, -radial.y * bevel, sqrt(max(0.001, 1.0 - bevel * bevel))));
    vec3 metal = studio(reflect(-view, metalNormal));
    metal *= 0.96 + 0.04 * sin(atan(p.y, p.x) * 3.0 + 0.4);
    metal = mix(metal, vec3(0.96, 0.98, 1.0), band(r, 0.989, 0.007) * 0.68);
    metal = mix(metal, vec3(0.30, 0.34, 0.39), band(r, 0.948, 0.007) * 0.6);
    float marker = (1.0 - smoothstep(0.012, 0.021, abs(p.x - 0.57))) * smoothstep(0.7, 0.8, -p.y);
    metal = mix(metal, vec3(0.12, 0.39, 0.94), marker * 0.9);

    vec3 lens = mix(metal, glass, glassMask);
    color = mix(color, lens, 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r));
  }
  gl_FragColor = vec4(color, 1.0);
}
`

type Point = { x: number; y: number }

function wrapTrace(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 5) {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] += '…'
  }
  return lines
}

export function createFocusRenderer(
  canvas: HTMLCanvasElement,
  traces: readonly FocusTrace[],
  onSelect: (index: number) => void,
  onUnavailable: () => void,
  initialIndex = 1
): FocusRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' })
  if (!gl) return null

  const shaders: WebGLShader[] = []
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)
    if (!shader) return null
    shaders.push(shader)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
  }

  const vertex = compile(gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  const textures = [gl.createTexture(), gl.createTexture()]
  const releaseGL = () => {
    for (const texture of textures) gl.deleteTexture(texture)
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    for (const shader of shaders) gl.deleteShader(shader)
  }

  if (!vertex || !fragment || !program || !buffer || textures.some((texture) => !texture)) {
    releaseGL()
    return null
  }

  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    releaseGL()
    return null
  }

  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  const uniforms = {
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    size: gl.getUniformLocation(program, 'u_size'),
    textureSize: gl.getUniformLocation(program, 'u_textureSize'),
    fieldOffset: gl.getUniformLocation(program, 'u_fieldOffset'),
    center: gl.getUniformLocation(program, 'u_center'),
    radius: gl.getUniformLocation(program, 'u_radius'),
    light: gl.getUniformLocation(program, 'u_light'),
  }
  gl.uniform1i(gl.getUniformLocation(program, 'u_base'), 0)
  gl.uniform1i(gl.getUniformLocation(program, 'u_focus'), 1)

  let disposed = false
  let visible = true
  let frame = 0
  let previousTime = 0
  let width = 1
  let height = 1
  let textureWidth = 1
  let compact = false
  let fieldOffset = 0
  let targetFieldOffset = 0
  let radius = 105
  let selected = initialIndex
  let centers: Point[] = []
  const center: Point = { x: 0, y: 0 }
  const target: Point = { x: 0, y: 0 }
  const light: Point = { x: 0, y: 0 }
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let gesture: {
    id: number
    start: Point
    offset: Point
    fieldOffset: number
    moving: boolean
    touch: boolean
  } | null = null

  const render = (time: number) => {
    frame = 0
    if (disposed || !visible || document.hidden) return
    const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.04) : 1 / 60
    previousTime = time
    const blend = motion.matches || gesture?.moving ? 1 : 1 - Math.exp(-18 * dt)
    center.x += (target.x - center.x) * blend
    center.y += (target.y - center.y) * blend
    fieldOffset += (targetFieldOffset - fieldOffset) * blend
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
    gl.uniform2f(uniforms.size, width, height)
    gl.uniform2f(uniforms.textureSize, textureWidth, height)
    gl.uniform1f(uniforms.fieldOffset, fieldOffset)
    gl.uniform2f(uniforms.center, center.x, center.y)
    gl.uniform2f(uniforms.light, light.x, light.y)
    gl.uniform1f(uniforms.radius, radius)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    if (Math.hypot(target.x - center.x, target.y - center.y) > 0.08 || Math.abs(targetFieldOffset - fieldOffset) > 0.08)
      frame = requestAnimationFrame(render)
    else previousTime = 0
  }

  const requestDraw = () => {
    if (!frame && !disposed && visible && !document.hidden) frame = requestAnimationFrame(render)
  }

  const resize = () => {
    if (disposed) return
    const bounds = canvas.getBoundingClientRect()
    width = Math.max(1, bounds.width)
    height = Math.max(1, bounds.height)
    compact = width < 720
    radius = compact ? Math.min(122, width * 0.35, height * 0.43) : Math.min(140, height * 0.43)
    const spread = compact ? radius * 2.3 : Math.min(width * 0.3, width / 2 - radius - 12)
    textureWidth = compact ? width + spread * 2 : width
    centers = [0, 1, 2].map((index) => ({
      x: compact ? width / 2 + index * spread : width / 2 + (index - 1) * spread,
      y: height * 0.46,
    }))
    fieldOffset = compact ? centers[selected].x - width / 2 : 0
    targetFieldOffset = fieldOffset
    Object.assign(center, { x: centers[selected].x - fieldOffset, y: centers[selected].y })
    Object.assign(target, center)
    const ratio = Math.min(window.devicePixelRatio || 1, 2, 2400 / width)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    gl.viewport(0, 0, canvas.width, canvas.height)

    const square = canvas.closest('.square-grid')
    const squareBounds = square?.getBoundingClientRect()
    const squareStyle = square ? getComputedStyle(square) : null
    const copy = square?.querySelector('.square-copy')
    const background = copy ? getComputedStyle(copy).backgroundColor : '#f8fafc'
    const lattice = square?.querySelector('.square-lattice')
    const showGrid = lattice && getComputedStyle(lattice).display !== 'none'
    const columns = Number.parseFloat(squareStyle?.getPropertyValue('--square-columns') || '10')
    const pitch = squareBounds ? squareBounds.width / columns : 120
    const font = getComputedStyle(canvas).fontFamily

    const maxTextureSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 4096)
    textures.forEach((texture, index) => {
      // Magnified lettering needs more source pixels than the display canvas.
      const textureRatio = Math.min(index ? 4 : 2, maxTextureSize / textureWidth)
      const source = document.createElement('canvas')
      source.width = Math.round(textureWidth * textureRatio)
      source.height = Math.round(height * textureRatio)
      const context = source.getContext('2d')
      if (!context) return
      context.scale(textureRatio, textureRatio)
      context.fillStyle = background
      context.fillRect(0, 0, textureWidth, height)

      if (showGrid && squareBounds) {
        const main = canvas.closest('main')
        context.fillStyle = main ? getComputedStyle(main).borderLeftColor : '#e1e5eb'
        const offsetX = ((squareBounds.left - bounds.left) % pitch) + pitch
        const offsetY = ((squareBounds.top - bounds.top) % pitch) + pitch
        for (let x = offsetX; x < textureWidth; x += pitch) context.fillRect(x - 0.5, 0, 0.5, height)
        for (let y = offsetY; y < height; y += pitch) context.fillRect(0, y - 0.5, textureWidth, 0.5)
      }

      traces.forEach((trace, traceIndex) => {
        const point = centers[traceIndex]
        context.textAlign = 'center'
        if (index === 0) {
          context.fillStyle = '#94a3b8'
          context.font = `500 9px ${font}`
          context.fillText(`${trace.app}  ·  ${trace.time}`, point.x, point.y - 56)
          context.fillStyle = '#64748b'
          context.font = `500 11px ${font}`
          context.fillText(trace.shortTitle, point.x, point.y - 37)
          context.font = `400 ${compact ? 11 : 12}px ${font}`
          context.fillStyle = '#8b95a3'
          const excerpt = wrapTrace(context, trace.excerpt, radius * 1.48)
          excerpt.forEach((line, lineIndex) => {
            context.fillText(line, point.x, point.y - 12 + lineIndex * 15)
          })
          return
        }

        context.fillStyle = '#2563eb'
        context.font = `600 8.5px ${font}`
        context.fillText('Remember.', point.x, point.y - 39)
        let textSize = compact ? 13 : 14
        context.font = `500 ${textSize}px ${font}`
        const widestLine = Math.max(...trace.lines.map((line) => context.measureText(line).width))
        textSize *= Math.min(1, (radius * 0.98) / widestLine)
        context.font = `500 ${textSize}px ${font}`
        context.fillStyle = '#0f172a'
        context.fillText(trace.lines[0], point.x, point.y - 9)
        context.fillText(trace.lines[1], point.x, point.y + textSize * 1.4 - 9)
        context.fillStyle = '#2563eb'
        context.fillRect(point.x - 9, point.y + 22, 18, 0.8)
        context.font = `500 7.3px ${font}`
        context.fillStyle = '#64748b'
        context.fillText(trace.shortTitle, point.x, point.y + 32)
        context.font = `400 6.8px ${font}`
        context.fillText(trace.sourceLabel, point.x, point.y + 43)
      })

      gl.activeTexture(index === 0 ? gl.TEXTURE0 : gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    })
    requestDraw()
  }

  const localPoint = (event: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const select = (index: number, animate: boolean) => {
    selected = index
    targetFieldOffset = compact ? centers[index].x - width / 2 : 0
    Object.assign(target, { x: centers[index].x - targetFieldOffset, y: centers[index].y })
    if (!animate || motion.matches) {
      Object.assign(center, target)
      fieldOffset = targetFieldOffset
    }
    onSelect(index)
    requestDraw()
  }

  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || gesture) return
    const point = localPoint(event)
    const inside = Math.hypot((point.x - center.x) / radius, (point.y - center.y) / (radius * 0.9)) < 1.1
    gesture = {
      id: event.pointerId,
      start: point,
      offset: inside ? { x: point.x - center.x, y: point.y - center.y } : { x: 0, y: 0 },
      fieldOffset,
      moving: false,
      touch: event.pointerType === 'touch',
    }
  }

  const moveLens = (point: Point) => {
    if (!gesture) return
    const dx = point.x - gesture.start.x
    if (compact) {
      targetFieldOffset = Math.max(0, Math.min(textureWidth - width, gesture.fieldOffset - dx * 1.8))
      target.x = width / 2 + Math.max(-16, Math.min(16, dx * 0.12))
    } else target.x = Math.max(radius + 2, Math.min(width - radius - 2, point.x - gesture.offset.x))
    target.y = Math.max(radius * 0.9 + 2, Math.min(height - radius * 0.9 - 20, point.y - gesture.offset.y))
  }

  const pointerMove = (event: PointerEvent) => {
    const point = localPoint(event)
    if (!motion.matches) {
      light.x = (point.x / width - 0.5) * 2
      light.y = (point.y / height - 0.5) * 2
    }
    if (gesture?.id === event.pointerId) {
      const dx = point.x - gesture.start.x
      const dy = point.y - gesture.start.y
      if (!gesture.moving && Math.hypot(dx, dy) > 5) {
        if (gesture.touch && Math.abs(dy) > Math.abs(dx)) {
          gesture = null
          return
        }
        gesture.moving = true
        canvas.setPointerCapture(event.pointerId)
        canvas.dataset.dragging = 'true'
      }
      if (gesture.moving) moveLens(point)
    }
    requestDraw()
  }

  const pointerUp = (event: PointerEvent) => {
    if (gesture?.id !== event.pointerId) return
    const point = localPoint(event)
    const dx = point.x - gesture.start.x
    const dy = point.y - gesture.start.y
    const moved = gesture.moving || (Math.abs(dx) > 5 && (!gesture.touch || Math.abs(dx) >= Math.abs(dy)))
    // The release can contain the last coalesced movement, especially on touch.
    if (moved) moveLens(point)
    const x = moved ? target.x + targetFieldOffset : point.x + fieldOffset
    gesture = null
    delete canvas.dataset.dragging
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    const nearest = centers.reduce(
      (best, point, index) => (Math.abs(point.x - x) < Math.abs(centers[best].x - x) ? index : best),
      0
    )
    select(nearest, true)
  }

  const cancel = () => {
    gesture = null
    delete canvas.dataset.dragging
    select(selected, true)
  }

  const leave = () => {
    if (gesture && !gesture.moving) gesture = null
    light.x = 0
    light.y = 0
    requestDraw()
  }

  const visibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      frame = 0
      previousTime = 0
    } else requestDraw()
  }

  const lost = (event: Event) => {
    event.preventDefault()
    disposed = true
    cancelAnimationFrame(frame)
    onUnavailable()
  }

  canvas.addEventListener('pointerdown', pointerDown)
  canvas.addEventListener('pointermove', pointerMove)
  canvas.addEventListener('pointerup', pointerUp)
  canvas.addEventListener('pointercancel', cancel)
  canvas.addEventListener('pointerleave', leave)
  canvas.addEventListener('webglcontextlost', lost)
  document.addEventListener('visibilitychange', visibility)
  motion.addEventListener('change', requestDraw)
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) requestDraw()
    else {
      cancelAnimationFrame(frame)
      frame = 0
      previousTime = 0
    }
  })
  intersection.observe(canvas)
  resize()
  document.fonts.ready.then(() => {
    if (!disposed) resize()
  })

  return {
    select,
    dispose: () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('webglcontextlost', lost)
      document.removeEventListener('visibilitychange', visibility)
      motion.removeEventListener('change', requestDraw)
      releaseGL()
    },
  }
}
