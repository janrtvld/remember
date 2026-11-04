import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectSharedMicrophone } from './selectSharedMicrophone'

const laptop = {
  kind: 'audioinput',
  deviceId: 'laptop-mic',
  groupId: 'internal',
  label: 'MacBook Pro Microphone (Built-in)',
  vendorMetadata: 'preserved',
}
const usb = { kind: 'audioinput', deviceId: 'usb-mic', groupId: 'usb', label: 'USB Podcast Microphone' }
const webcam = { kind: 'audioinput', deviceId: 'webcam-mic', groupId: 'webcam', label: 'Camera Microphone' }
const defaultUsb = {
  kind: 'audioinput',
  deviceId: 'default',
  groupId: 'usb',
  label: 'Default - USB Podcast Microphone',
}

test('conversation capture prefers the laptop microphone while accurately reporting a different system default', () => {
  const result = selectSharedMicrophone([defaultUsb, usb, laptop, webcam])
  assert.equal(result.microphone, laptop)
  assert.equal(result.defaultSelected, false)
  // The generic helper returns the original device, preserving all MediaDeviceInfo fields/methods.
  const richResult = selectSharedMicrophone([laptop])
  assert.equal(richResult.microphone?.vendorMetadata, 'preserved')
  assert.equal(richResult.defaultSelected, true)
})

test('an external-only setup selects the physical input behind the default alias, not enumeration order', () => {
  const result = selectSharedMicrophone([webcam, defaultUsb, usb])
  assert.equal(result.microphone, usb)
  assert.equal(result.defaultSelected, true)
})

test('an unmatched default alias remains usable for Chromium virtual and QA audio devices', () => {
  const virtualDefault = {
    kind: 'audioinput',
    deviceId: 'default',
    groupId: 'virtual',
    label: 'Fake Default Audio Input',
  }
  const result = selectSharedMicrophone([webcam, usb, virtualDefault])
  assert.equal(result.microphone, virtualDefault)
  assert.equal(result.defaultSelected, true)
  const active = selectSharedMicrophone([webcam, virtualDefault, usb], { deviceId: 'default' })
  assert.equal(active.microphone, virtualDefault)
  assert.equal(active.defaultSelected, true)
})

test('an active USB track remains selected when a built-in microphone appears or the default changes', () => {
  const defaultLaptop = { ...defaultUsb, groupId: 'internal', label: 'Default - MacBook Pro Microphone' }
  const result = selectSharedMicrophone([laptop, defaultLaptop, usb], { deviceId: usb.deviceId })
  assert.equal(result.microphone, usb)
  assert.equal(result.defaultSelected, false)
})

test('removing an active microphone fails instead of silently recording from a replacement', () => {
  assert.throws(() => selectSharedMicrophone([laptop, defaultUsb], { deviceId: usb.deviceId }), /disconnected/)
  assert.throws(() => selectSharedMicrophone([laptop], {}), /disconnected/)
})

test('output devices and communications aliases cannot displace the intended input', () => {
  const output = { ...laptop, kind: 'audiooutput' }
  const communications = { ...usb, deviceId: 'communications', label: 'Communications - USB Podcast Microphone' }
  assert.equal(selectSharedMicrophone([output, communications, webcam]).microphone, webcam)
  assert.deepEqual(selectSharedMicrophone([output, communications]), { microphone: null, defaultSelected: false })
  assert.deepEqual(selectSharedMicrophone([]), { microphone: null, defaultSelected: false })
})

test('localized built-in labels are recognized without selecting a same-named speaker', () => {
  const localized = { ...laptop, label: 'Interne microfoon', deviceId: 'internal-mic' }
  const output = { ...localized, kind: 'audiooutput', deviceId: 'internal-output' }
  const result = selectSharedMicrophone([output, defaultUsb, usb, localized])
  assert.equal(result.microphone, localized)
  assert.equal(result.defaultSelected, false)
})
