import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

export const workFragments = [
  {
    app: 'Figma',
    time: '16:32',
    title: 'Onboarding, versie 4',
    detail: 'Flow klaar. Elena moet nog reviewen.',
    color: '#7659ba',
    kind: 'design',
  },
  {
    app: 'Gesprek',
    time: '10:42',
    title: 'Dit spraken we af',
    detail: 'Donderdag live. Eerst de lege staat.',
    color: '#2860df',
    kind: 'audio',
  },
  {
    app: 'Code',
    time: '11:18',
    title: 'Een kleine doorbraak',
    detail: 'De terugknop blijft altijd zichtbaar.',
    color: '#39475a',
    kind: 'code',
  },
  {
    app: 'Notities',
    time: '13:06',
    title: 'Even onthouden',
    detail: 'De eerste ervaring moet rust geven.',
    color: '#bb8c38',
    kind: 'note',
  },
  {
    app: 'Browser',
    time: '14:21',
    title: 'Dat ene artikel',
    detail: 'Minder stappen. Meer vertrouwen.',
    color: '#437b6b',
    kind: 'browser',
  },
  {
    app: 'Bericht',
    time: '15:49',
    title: 'Nog even delen',
    detail: 'Kun je morgen naar de flow kijken?',
    color: '#5373d3',
    kind: 'message',
  },
  {
    app: 'Terminal',
    time: '16:03',
    title: 'Alles weer groen',
    detail: 'Build geslaagd. Klaar voor review.',
    color: '#38454e',
    kind: 'terminal',
  },
  {
    app: 'Document',
    time: '16:50',
    title: 'Waarom we dit kozen',
    detail: 'Toestemming vragen, ruimte laten.',
    color: '#5d79a0',
    kind: 'document',
  },
] as const

function fragmentTexture(index: number) {
  const item = workFragments[index % workFragments.length]
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 576
  const context = canvas.getContext('2d')
  if (!context) return new THREE.CanvasTexture(canvas)

  const c = context
  c.fillStyle = '#fbfcfe'
  c.fillRect(0, 0, 960, 576)
  c.fillStyle = item.color
  c.beginPath()
  c.roundRect(42, 42, 64, 64, 16)
  c.fill()
  c.fillStyle = '#fff'
  c.font = 'bold 35px Arial'
  c.textAlign = 'center'
  c.fillText(item.app.slice(0, 1), 74, 87)
  c.textAlign = 'left'
  c.fillStyle = '#667080'
  c.font = '28px Arial'
  c.fillText(item.app, 127, 84)
  c.textAlign = 'right'
  c.fillText(item.time, 914, 84)
  c.textAlign = 'left'
  c.fillStyle = '#1a2539'
  c.font = 'bold 46px Arial'
  c.fillText(item.title, 46, 187)
  c.fillStyle = '#657084'
  c.font = '29px Arial'
  c.fillText(item.detail, 46, 241)

  if (item.kind === 'audio') {
    c.fillStyle = '#3d70ef'
    for (let i = 0; i < 65; i++) {
      const h = 16 + Math.abs(Math.sin(i * 1.71) * Math.sin(i * 0.21)) * 100
      c.beginPath()
      c.roundRect(47 + i * 13.2, 375 - h / 2, 6, h, 3)
      c.fill()
    }
  } else if (item.kind === 'design') {
    for (let i = 0; i < 3; i++) {
      c.fillStyle = ['#e8e6f5', '#e0e9ff', '#e9edf3'][i]
      c.beginPath()
      c.roundRect(47 + i * 294, 295, 270, 170, 12)
      c.fill()
      c.fillStyle = '#ffffff'
      c.beginPath()
      c.roundRect(67 + i * 294, 316, 230, 95, 6)
      c.fill()
      c.fillStyle = '#4471e7'
      c.beginPath()
      c.roundRect(67 + i * 294, 428, 110, 13, 6)
      c.fill()
    }
  } else if (item.kind === 'code' || item.kind === 'terminal') {
    c.fillStyle = '#eef1f6'
    c.beginPath()
    c.roundRect(46, 292, 866, 175, 12)
    c.fill()
    c.font = '29px monospace'
    const lines =
      item.kind === 'code'
        ? ['const back = () => history.back()', '<BackButton visible />', '// ruimte om terug te gaan']
        : ['$ pnpm build', '✓  compiled successfully', '✓  ready for review']
    lines.forEach((line, row) => {
      c.fillStyle = row === 1 ? '#3d72ce' : '#6a7485'
      c.fillText(line, 72, 337 + row * 48)
    })
  } else {
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i === 0 ? `${item.color}55` : '#dfe5ed'
      c.beginPath()
      c.roundRect(47, 305 + i * 43, [690, 826, 735, 470][i], 12, 6)
      c.fill()
    }
  }

  c.fillStyle = '#99a3b2'
  c.font = '21px Arial'
  c.fillText('REMEMBER  /  EEN MOMENT UIT JE DAG', 47, 533)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

export function createWorkFragment(index: number) {
  const group = new THREE.Group()
  const geometry = new RoundedBoxGeometry(1.55, 0.93, 0.045, 3, 0.055)
  const body = new THREE.Mesh(
    geometry,
    new THREE.MeshPhysicalMaterial({ color: '#edf1f8', roughness: 0.3, metalness: 0.08, clearcoat: 0.5 })
  )
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  const texture = fragmentTexture(index)
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(1.48, 0.87),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  )
  face.position.z = 0.025
  group.add(face)
  group.userData.fragmentIndex = index
  return group
}
