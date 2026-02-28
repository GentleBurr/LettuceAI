<div align="center">
  <img src="https://github.com/LettuceAI/.github/blob/main/profile/LettuceAI-banner.png" alt="LettuceAI Banner" />
  
  # LettuceAI
  
  **Official application repository for LettuceAI**
  
  [Overview](#overview) • [Install](#install) • [Development](#development) • [Android](#android) • [iOS](#ios) • [Contributing](#contributing)
</div>

## Overview

This repository contains the LettuceAI application. LettuceAI is a privacy-first, cross‑platform roleplay and storytelling app built with Tauri v2, React, and TypeScript. It runs locally, keeps data on‑device, and lets users bring their own API keys and models.

## Install

### Prerequisites

- Bun 1.1+ (includes Node.js compatibility): https://bun.sh/
- Rust 1.70+ and Cargo
- Android SDK (optional, for Android builds)
- Xcode + iOS SDK (optional, for iOS builds, macOS only)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/LettuceAI/mobile-app.git
cd mobile-app

# Install dependencies
bun install
```

## Development

### Common Commands

```bash
# Desktop (Tauri)
bun run tauri dev
bun run tauri build

# Desktop with NVIDIA CUDA llama.cpp acceleration
bun run tauri dev --features llama-gpu-cuda
bun run tauri build --features llama-gpu-cuda

# Desktop with NVIDIA CUDA llama.cpp acceleration (auto-detect local GPU arch)
bun run tauri:dev:cuda:auto
bun run tauri:build:cuda:auto

# Desktop with Vulkan llama.cpp acceleration (AMD/Intel/NVIDIA, driver-dependent)
bun run tauri dev --features llama-gpu-vulkan
bun run tauri build --features llama-gpu-vulkan

# Android
bun run tauri android dev
bun run tauri android build

# Quality
bunx tsc --noEmit
bun run check
```

## Android

### Setup

- Install Android Studio and set up the SDK
- Ensure `ANDROID_SDK_ROOT` is set in your environment
- Add platform tools to your `PATH` (example: `export PATH=$ANDROID_SDK_ROOT/platform-tools:$PATH`)

### Build and Run

```bash
# Run on Android emulator
bun run tauri android dev

# Build Android APK
bun run tauri android build
```

## iOS

### Setup (macOS only)

- Install Xcode from the App Store
- Install Xcode command-line tools: `xcode-select --install`
- Install CocoaPods: `sudo gem install cocoapods` (or Homebrew)
- Provide ONNX Runtime for iOS with CoreML support:
  - Build/download an iOS-compatible ONNX Runtime package that includes CoreML EP
  - Set `ORT_LIB_LOCATION` to the directory containing the ONNX Runtime libraries before building
- Initialize iOS project files:

```bash
export ORT_LIB_LOCATION=/absolute/path/to/onnxruntime/ios/libs
bun run tauri ios init
```

### Build and Run

```bash
# Run on iOS simulator/device (from macOS)
bun run tauri ios dev

# Build iOS app
bun run tauri ios build
```

For `llama-gpu-cuda`, install the NVIDIA CUDA toolkit and driver on the build machine.

## Contributing

We welcome contributions.

1. Fork the repo
2. Create a feature branch `git checkout -b feature/my-change`
3. Follow TypeScript and React best practices
4. Test your changes
5. Commit with clear, conventional messages
6. Push and open a PR

## License

GNU Affero General Public License v3.0 — see `LICENSE`

<div align="center">
  <p>Privacy-first • Local-first • Open Source</p>
</div>
