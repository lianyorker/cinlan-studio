# Local Z-Image Turbo Installer for Cinlan Studio (Windows)
# Detects hardware, gates on specs, downloads models, runs ComfyUI

param()
$ErrorActionPreference = "Stop"

$INSTALL_DIR = $env:CINLAN_LOCAL_DIR ? $env:CINLAN_LOCAL_DIR : "$env:USERPROFILE\cinlan-local"
$COMFYUI_REPO = "https://github.com/comfyanonymous/ComfyUI.git"
$MODELS_BASE = "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files"

# Helper functions
function Log-Info {
  param([string]$Message)
  Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Log-Success {
  param([string]$Message)
  Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

function Log-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Log-Error {
  param([string]$Message)
  Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Spec-Fail {
  param([string]$Msg1, [string]$Msg2)
  Write-Host ""
  Write-Host "=== Hardware Requirements Not Met ===" -ForegroundColor Red
  Write-Host $Msg1
  Write-Host ""
  Write-Host "Cloud Alternative:" -ForegroundColor Yellow
  Write-Host "Configure Cinlan Studio with a cloud API to use cloud generation"
  Write-Host "Sign up with your API key and get 35 free credits / 무료 35크레딧 to get started"
  Write-Host ""
  Write-Host $Msg2
  exit 2
}

# Detect hardware and set tier
function Detect-Hardware {
  Log-Info "Checking NVIDIA GPU..."
  
  $gpu_info = $null
  try {
    $gpu_output = & nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($gpu_output) {
      $parts = $gpu_output.Trim() -split '\s+', 2
      $mem_mb = [int]$parts[0]
      $gpu_name = $parts[1]
      Log-Info "Detected: $gpu_name with ${mem_mb}MB VRAM"
      
      if ($mem_mb -lt 8000) {
        Spec-Fail `
          "NVIDIA GPU with ${mem_mb}MB VRAM detected - requires 8000MB+ (8GB)." `
          "Your GPU does not meet minimum memory requirements."
      } elseif ($mem_mb -lt 14000) {
        $script:TIER = "int8"
        Log-Info "Tier: int8 (quantized, ~${mem_mb}MB VRAM)"
      } else {
        $script:TIER = "bf16"
        Log-Info "Tier: bf16 (full precision, ~${mem_mb}MB VRAM)"
      }
      return
    }
  } catch {
    # nvidia-smi not found
  }
  
  Spec-Fail `
    "No NVIDIA GPU detected (nvidia-smi not found)." `
    "Local generation requires NVIDIA GPU 8GB+ VRAM."
}

# Check prerequisites
function Check-Prereqs {
  Log-Info "Checking prerequisites..."
  
  # Check Python
  $py_cmd = $null
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $py_cmd = "py"
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $py_cmd = "python"
  } else {
    Log-Error "Python not found. Please install Python 3.10+."
    exit 1
  }
  
  Log-Info "Python found ($py_cmd)"
  
  # Check git
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Log-Error "git not found. Please install git."
    exit 1
  }
  
  Log-Info "git found"
}

# Setup ComfyUI
function Setup-ComfyUI {
  Log-Info "Setting up ComfyUI in $INSTALL_DIR..."
  
  if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
  }
  
  if (-not (Test-Path "$INSTALL_DIR/ComfyUI")) {
    Log-Info "Cloning ComfyUI..."
    git clone $COMFYUI_REPO "$INSTALL_DIR/ComfyUI"
  } else {
    Log-Info "ComfyUI directory exists, updating..."
    try {
      git -C "$INSTALL_DIR/ComfyUI" pull --ff-only 2>$null
    } catch {
      Log-Warn "Could not update ComfyUI"
    }
  }
  
  # Setup venv
  if (-not (Test-Path "$INSTALL_DIR/venv")) {
    Log-Info "Creating Python virtual environment..."
    & py -3.11 -m venv "$INSTALL_DIR/venv" 2>$null
    if ($LASTEXITCODE -ne 0) {
      & py -m venv "$INSTALL_DIR/venv"
    }
  }
  
  $venv_activate = "$INSTALL_DIR/venv/Scripts/Activate.ps1"
  & $venv_activate
  
  Log-Info "Installing PyTorch with CUDA support..."
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124 -q
  
  Log-Info "Installing ComfyUI dependencies..."
  pip install -r "$INSTALL_DIR/ComfyUI/requirements.txt" -q
}

# Download models
function Download-Models {
  Log-Info "Downloading Z-Image Turbo models (tier: $script:TIER)..."
  
  New-Item -ItemType Directory -Path "$INSTALL_DIR/ComfyUI/models/diffusion_models" -Force | Out-Null
  New-Item -ItemType Directory -Path "$INSTALL_DIR/ComfyUI/models/text_encoders" -Force | Out-Null
  New-Item -ItemType Directory -Path "$INSTALL_DIR/ComfyUI/models/vae" -Force | Out-Null
  
  $files_to_download = @()
  if ($script:TIER -eq "bf16") {
    $files_to_download = @(
      "diffusion_models/z_image_turbo_bf16.safetensors",
      "text_encoders/qwen_3_4b.safetensors",
      "vae/ae.safetensors"
    )
  } else {
    $files_to_download = @(
      "diffusion_models/z_image_turbo_int8_convrot.safetensors",
      "text_encoders/qwen_3_4b_fp8_mixed.safetensors",
      "vae/ae.safetensors"
    )
  }
  
  foreach ($file in $files_to_download) {
    $filename = Split-Path $file -Leaf
    $target = Join-Path "$INSTALL_DIR/ComfyUI/models" $file
    
    if (Test-Path $target) {
      $size = (Get-Item $target).Length
      Log-Info "File exists: $filename ($size bytes)"
      continue
    }
    
    Log-Info "Downloading $filename..."
    $url = "$MODELS_BASE/$file"
    
    try {
      Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -ErrorAction Stop
    } catch {
      try {
        curl.exe -L -C - -o $target $url
      } catch {
        Log-Error "Failed to download $filename"
      }
    }
  }
}

# Create run script
function Create-RunScript {
  Log-Info "Creating run script..."
  
  $run_ps1 = @"
`$SCRIPT_DIR = Split-Path -Parent `$MyInvocation.MyCommand.Path
& "`$SCRIPT_DIR\venv\Scripts\Activate.ps1"
python "`$SCRIPT_DIR\ComfyUI\main.py" --listen 127.0.0.1 --port 8188 --enable-cors-header "*"
"@
  
  $run_ps1 | Out-File -FilePath "$INSTALL_DIR/run.ps1" -Encoding UTF8
  Log-Success "Run script created at $INSTALL_DIR/run.ps1"
}

# Main
function Main {
  Write-Host "================================================" -ForegroundColor Cyan
  Write-Host "  Z-Image Turbo Local Installation" -ForegroundColor Cyan
  Write-Host "  (Apache 2.0, runs fully on-device)" -ForegroundColor Cyan
  Write-Host "================================================" -ForegroundColor Cyan
  Write-Host ""
  
  $script:TIER = "int8"
  
  Detect-Hardware
  Check-Prereqs
  Setup-ComfyUI
  Download-Models
  Create-RunScript
  
  Write-Host ""
  Write-Host "================================================" -ForegroundColor Green
  Write-Host "  Installation Complete!" -ForegroundColor Green
  Write-Host "================================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "1. Start ComfyUI:"
  Write-Host "   powershell `"$INSTALL_DIR/run.ps1`""
  Write-Host ""
  Write-Host "2. Open Cinlan Studio and:"
  Write-Host "   - Connect to localhost:8188"
  Write-Host "   - Select 'Z-Image Turbo (Local · Free)'"
  Write-Host ""
  Write-Host "3. Generate images locally, free and private!"
  Write-Host ""
}

Main
