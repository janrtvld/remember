#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

static const Float32 DUCKED_VOLUME = 0.1f;

static AudioObjectPropertyAddress propertyAddress(AudioObjectPropertySelector selector, UInt32 element) {
  return (AudioObjectPropertyAddress){
      selector,
      kAudioDevicePropertyScopeOutput,
      element,
  };
}

static Boolean defaultOutputDevice(AudioObjectID *device) {
  AudioObjectPropertyAddress address = {
      kAudioHardwarePropertyDefaultOutputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  UInt32 size = sizeof(*device);
  return AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, device) == noErr &&
         *device != kAudioObjectUnknown;
}

static Boolean outputDeviceIsPlaying(AudioObjectID device) {
  AudioObjectPropertySelector selectors[] = {
      kAudioDevicePropertyDeviceIsRunningSomewhere,
      kAudioDevicePropertyDeviceIsRunning,
  };
  AudioObjectPropertyScope scopes[] = {
      kAudioObjectPropertyScopeGlobal,
      kAudioDevicePropertyScopeOutput,
  };
  for (UInt32 selectorIndex = 0; selectorIndex < 2; selectorIndex++) {
    for (UInt32 scopeIndex = 0; scopeIndex < 2; scopeIndex++) {
      AudioObjectPropertyAddress address = {
          selectors[selectorIndex],
          scopes[scopeIndex],
          kAudioObjectPropertyElementMain,
      };
      UInt32 value = 0;
      UInt32 size = sizeof(value);
      if (AudioObjectHasProperty(device, &address) &&
          AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &value) == noErr && value != 0) {
        return true;
      }
    }
  }
  return false;
}

static NSString *deviceUID(AudioObjectID device) {
  AudioObjectPropertyAddress address = {
      kAudioDevicePropertyDeviceUID,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  CFStringRef value = NULL;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &value) != noErr || value == NULL) return nil;
  return CFBridgingRelease(value);
}

static AudioObjectID deviceWithUID(NSString *requestedUID) {
  AudioObjectPropertyAddress address = {
      kAudioHardwarePropertyDevices,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr || size == 0) {
    return kAudioObjectUnknown;
  }

  AudioObjectID *devices = malloc(size);
  if (devices == NULL) return kAudioObjectUnknown;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, devices) != noErr) {
    free(devices);
    return kAudioObjectUnknown;
  }

  AudioObjectID match = kAudioObjectUnknown;
  UInt32 count = size / sizeof(AudioObjectID);
  for (UInt32 index = 0; index < count; index++) {
    if ([deviceUID(devices[index]) isEqualToString:requestedUID]) {
      match = devices[index];
      break;
    }
  }
  free(devices);
  return match;
}

static Boolean isSettable(AudioObjectID device, AudioObjectPropertySelector selector, UInt32 element) {
  AudioObjectPropertyAddress address = propertyAddress(selector, element);
  Boolean settable = false;
  return AudioObjectHasProperty(device, &address) &&
         AudioObjectIsPropertySettable(device, &address, &settable) == noErr && settable;
}

static Boolean readFloatValue(AudioObjectID device,
                              AudioObjectPropertySelector selector,
                              UInt32 element,
                              Float32 *value) {
  AudioObjectPropertyAddress address = propertyAddress(selector, element);
  UInt32 size = sizeof(*value);
  return AudioObjectGetPropertyData(device, &address, 0, NULL, &size, value) == noErr;
}

static Boolean setFloatValue(AudioObjectID device,
                             AudioObjectPropertySelector selector,
                             UInt32 element,
                             Float32 value) {
  AudioObjectPropertyAddress address = propertyAddress(selector, element);
  return AudioObjectSetPropertyData(device, &address, 0, NULL, sizeof(value), &value) == noErr;
}

static Boolean readUInt32Value(AudioObjectID device,
                               AudioObjectPropertySelector selector,
                               UInt32 element,
                               UInt32 *value) {
  AudioObjectPropertyAddress address = propertyAddress(selector, element);
  UInt32 size = sizeof(*value);
  return AudioObjectGetPropertyData(device, &address, 0, NULL, &size, value) == noErr;
}

static Boolean setUInt32Value(AudioObjectID device,
                              AudioObjectPropertySelector selector,
                              UInt32 element,
                              UInt32 value) {
  AudioObjectPropertyAddress address = propertyAddress(selector, element);
  return AudioObjectSetPropertyData(device, &address, 0, NULL, sizeof(value), &value) == noErr;
}

static NSArray<NSNumber *> *preferredVolumeElements(AudioObjectID device) {
  if (isSettable(device, kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyElementMain)) {
    Float32 value = 0;
    if (readFloatValue(device, kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyElementMain, &value)) {
      return @[ @(kAudioObjectPropertyElementMain) ];
    }
  }

  AudioObjectPropertyAddress address = {
      kAudioDevicePropertyPreferredChannelsForStereo,
      kAudioDevicePropertyScopeOutput,
      kAudioObjectPropertyElementMain,
  };
  UInt32 channels[2] = { 0, 0 };
  UInt32 size = sizeof(channels);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, channels) != noErr) return nil;

  NSMutableArray<NSNumber *> *elements = [NSMutableArray array];
  for (UInt32 index = 0; index < 2; index++) {
    UInt32 element = channels[index];
    Float32 value = 0;
    if (element == 0 || !isSettable(device, kAudioDevicePropertyVolumeScalar, element) ||
        !readFloatValue(device, kAudioDevicePropertyVolumeScalar, element, &value)) {
      return nil;
    }
    if (![elements containsObject:@(element)]) [elements addObject:@(element)];
  }
  return elements.count > 0 ? elements : nil;
}

static NSDictionary *readControlState(AudioObjectID device) {
  NSString *uid = deviceUID(device);
  if (uid == nil) return nil;

  NSArray<NSNumber *> *volumeElements = preferredVolumeElements(device);
  if (volumeElements != nil) {
    NSMutableArray<NSNumber *> *values = [NSMutableArray arrayWithCapacity:volumeElements.count];
    for (NSNumber *element in volumeElements) {
      Float32 value = 0;
      if (!readFloatValue(device, kAudioDevicePropertyVolumeScalar, element.unsignedIntValue, &value)) return nil;
      [values addObject:@(value)];
    }
    return @{ @"version" : @1, @"deviceUID" : uid, @"kind" : @"volume", @"elements" : volumeElements, @"values" : values };
  }

  if (isSettable(device, kAudioDevicePropertyMute, kAudioObjectPropertyElementMain)) {
    UInt32 value = 0;
    if (readUInt32Value(device, kAudioDevicePropertyMute, kAudioObjectPropertyElementMain, &value)) {
      return @{ @"version" : @1,
                @"deviceUID" : uid,
                @"kind" : @"mute",
                @"elements" : @[ @(kAudioObjectPropertyElementMain) ],
                @"values" : @[ @(value) ] };
    }
  }

  return nil;
}

static Boolean applyControlState(AudioObjectID device, NSDictionary *state, Boolean duck) {
  NSString *kind = state[@"kind"];
  NSArray<NSNumber *> *elements = state[@"elements"];
  NSArray<NSNumber *> *values = state[@"values"];
  if (![kind isKindOfClass:[NSString class]] || ![elements isKindOfClass:[NSArray class]] ||
      ![values isKindOfClass:[NSArray class]] || elements.count == 0 || elements.count != values.count) {
    return false;
  }

  if ([kind isEqualToString:@"volume"]) {
    Float32 highest = 0;
    for (NSNumber *value in values) highest = fmaxf(highest, value.floatValue);
    Float32 scale = duck && highest > DUCKED_VOLUME ? DUCKED_VOLUME / highest : 1;
    NSMutableArray<NSNumber *> *applied = [NSMutableArray arrayWithCapacity:elements.count];
    for (NSUInteger index = 0; index < elements.count; index++) {
      Float32 value = values[index].floatValue * scale;
      if (!setFloatValue(device, kAudioDevicePropertyVolumeScalar, elements[index].unsignedIntValue, value)) {
        for (NSUInteger rollback = 0; rollback < applied.count; rollback++) {
          setFloatValue(device,
                        kAudioDevicePropertyVolumeScalar,
                        elements[rollback].unsignedIntValue,
                        values[rollback].floatValue);
        }
        return false;
      }
      [applied addObject:elements[index]];
    }
    return true;
  }

  if ([kind isEqualToString:@"mute"] && elements.count == 1) {
    UInt32 value = duck ? 1 : values.firstObject.unsignedIntValue;
    return setUInt32Value(device, kAudioDevicePropertyMute, elements.firstObject.unsignedIntValue, value);
  }
  return false;
}

static Boolean controlStateNeedsDucking(NSDictionary *state) {
  NSString *kind = state[@"kind"];
  NSArray<NSNumber *> *values = state[@"values"];
  if ([kind isEqualToString:@"mute"]) return values.firstObject.unsignedIntValue == 0;
  for (NSNumber *value in values) {
    if (value.floatValue > DUCKED_VOLUME) return true;
  }
  return false;
}

static NSDictionary *readStateFile(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static Boolean writeStateFile(NSString *path, NSDictionary *state) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
  return data != nil && [data writeToFile:path options:NSDataWritingAtomic error:nil];
}

static void removeStateFile(NSString *path) {
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
}

static NSString *restoreFromFile(NSString *path) {
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return @"clean";
  NSDictionary *state = readStateFile(path);
  NSString *uid = state[@"deviceUID"];
  if (state == nil || ![uid isKindOfClass:[NSString class]]) {
    removeStateFile(path);
    return @"invalid";
  }

  AudioObjectID device = deviceWithUID(uid);
  if (device == kAudioObjectUnknown || !applyControlState(device, state, false)) return @"pending";
  removeStateFile(path);
  return @"restored";
}

static void printLine(NSString *value) {
  fprintf(stdout, "%s\n", value.UTF8String);
  fflush(stdout);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2 || argc > 3) return 64;
    NSString *action = [NSString stringWithUTF8String:argv[1]];

    if ([action isEqualToString:@"status"]) {
      AudioObjectID device = kAudioObjectUnknown;
      NSDictionary *state = defaultOutputDevice(&device) ? readControlState(device) : nil;
      NSData *data = state == nil ? nil : [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
      printLine(data == nil ? @"unsupported" : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
      return state == nil ? 1 : 0;
    }

    if ([action isEqualToString:@"playing"]) {
      AudioObjectID device = kAudioObjectUnknown;
      Boolean isPlaying = defaultOutputDevice(&device) && outputDeviceIsPlaying(device);
      printLine(isPlaying ? @"playing" : @"idle");
      return 0;
    }

    if (argc != 3) return 64;
    NSString *statePath = [NSString stringWithUTF8String:argv[2]];
    if ([action isEqualToString:@"restore"]) {
      printLine(restoreFromFile(statePath));
      return 0;
    }
    if (![action isEqualToString:@"duck"]) return 64;

    NSString *staleRestore = restoreFromFile(statePath);
    if ([staleRestore isEqualToString:@"pending"]) {
      printLine(@"pending");
      return 0;
    }

    AudioObjectID device = kAudioObjectUnknown;
    if (!defaultOutputDevice(&device)) {
      printLine(@"unsupported");
      return 0;
    }
    NSDictionary *state = readControlState(device);
    if (state == nil) {
      printLine(@"unsupported");
      return 0;
    }
    if (!controlStateNeedsDucking(state)) {
      printLine(@"unchanged");
      return 0;
    }
    if (!writeStateFile(statePath, state) || !applyControlState(device, state, true)) {
      removeStateFile(statePath);
      printLine(@"failed");
      return 1;
    }
    printLine(@"ducked");
    return 0;
  }
}
