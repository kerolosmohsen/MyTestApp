/** @type {Detox.DetoxConfig} */
module.exports = {
  "testRunner": {
    "args": {
      "$0": "jest",
      "config": "e2e/jest.config.js"
    },
    "jest": {
      "setupTimeout": 120000
    }
  },
  "apps": {
    "ios.sim.debug": {
      "type": "ios.simulator",
      "binaryPath": "ios/build/Build/Products/Debug-iphonesimulator/MyTestApp.app",
      "build": "xcodebuild -workspace 'ios/MyTestApp.xcworkspace' -scheme 'MyTestApp' -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build COMPILER_INDEX_STORE_ENABLE=NO"
    }
  },
  "devices": {
    "simulator": {
      "type": "ios.simulator",
      "device": {
        "type": process.env.UI_IOS_SIMULATOR || "iPhone 16"
      }
    }
  },
  "configurations": {
    "ios.sim.debug": {
      "device": "simulator",
      "app": "ios.sim.debug"
    }
  }
};
