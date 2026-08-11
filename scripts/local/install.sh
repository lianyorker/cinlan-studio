#!/bin/bash
set -euo pipefail

# Local Z-Image Turbo Installer for Cinlan Studio
# Detects hardware, gates on specs, downloads models, runs ComfyUI

INSTALL_DIR="${CINLAN_LOCAL_DIR:-$HOME/cinlan-local}"
COMFYUI_REPO="https://github.com/comfyanonymous/ComfyUI.git"
MODELS_BASE="https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files"

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

spec_fail() {
  local msg1="$1"
  local msg2="$2"
  echo ""
  echo -e "${RED}=== Hardware Requirements Not Met ===${NC}"
  echo "$msg1"
  echo ""
  echo -e "${YELLOW}Cloud Alternative:${NC}"
  echo "Configure Cinlan Studio with a cloud API to use cloud generation"
  echo "Sign up with your API key and get 35 free credits / 무료 35크레딧 to get started"
  echo ""
  echo "$msg2"
  exit 2
}

# Detect hardware and set tier
detect_hardware() {
  local os=$(uname -s)
  
  if [ "$os" == "Darwin" ]; then
    # macOS
    local arch=$(uname -m)
    if [ "$arch" == "arm64" ]; then
      local mem_bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
      local mem_gb=$((mem_bytes / 1024 / 1024 / 1024))
      
      log_info "Detected: macOS arm64 with ${mem_gb}GB unified memory"
      
      # Apple Silicon = 풀 GGUF 티어 (실측 M4 Pro: ~2.5분/장 @1024px, 상주 ~10GB)
      # int8은 MPS 커널 부재로 불가, bf16은 19GB 스왑으로 비실용 → GGUF가 유일 실용 경로
      if [ "$mem_gb" -lt 16 ]; then
        spec_fail \
          "Apple Silicon with ${mem_gb}GB unified memory detected - requires 16GB+ (local runtime uses ~10GB while generating)." \
          "Cloud generation works great on any Mac - no download needed."
      fi

      if [ "$mem_gb" -lt 24 ]; then
        log_warn "16GB Mac: close other heavy apps while generating (runtime uses ~10GB)"
      fi
      log_warn "Apple Silicon detected: GGUF tier (~10GB download; measured ~2-2.5 min/image on M4 Pro)"
      TIER="gguf"
      return 0
    else
      spec_fail \
        "macOS with $arch architecture detected." \
        "Local generation requires arm64 (Apple Silicon) Mac."
    fi
  elif [ "$os" == "Linux" ]; then
    # Linux - check for NVIDIA GPU
    if ! command -v nvidia-smi &>/dev/null; then
      spec_fail \
        "No NVIDIA GPU detected (nvidia-smi not found)." \
        "Local generation requires NVIDIA GPU 8GB+ VRAM."
    fi
    
    local gpu_info=$(nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits 2>/dev/null | head -1)
    local mem_mb=$(echo "$gpu_info" | awk '{print $1}')
    local gpu_name=$(echo "$gpu_info" | cut -d' ' -f2-)
    
    log_info "Detected: $gpu_name with ${mem_mb}MB VRAM"
    
    if [ "$mem_mb" -lt 8000 ]; then
      spec_fail \
        "NVIDIA GPU with ${mem_mb}MB VRAM detected - requires 8000MB+ (8GB)." \
        "Your GPU does not meet minimum memory requirements."
    elif [ "$mem_mb" -lt 14000 ]; then
      TIER="int8"
      log_info "Tier: int8 (quantized, ~${mem_mb}MB VRAM)"
    else
      TIER="bf16"
      log_info "Tier: bf16 (full precision, ~${mem_mb}MB VRAM)"
    fi
    return 0
  else
    spec_fail \
      "Unsupported OS: $os" \
      "Local generation supports macOS (arm64) and Linux (NVIDIA GPU)."
  fi
}

# Check prerequisites
check_prereqs() {
  log_info "Checking prerequisites..."
  
  if ! command -v git &>/dev/null; then
    log_error "git not found. Please install git."
    exit 1
  fi
  log_info "git found"
  
  if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
    log_error "Python not found. Please install Python 3.10+."
    exit 1
  fi
  log_info "Python found"
  
  # Check disk space (df -Pk: macOS/Linux 공통 POSIX 플래그)
  mkdir -p "$INSTALL_DIR"
  local available_kb=$(df -Pk "$INSTALL_DIR" 2>/dev/null | tail -1 | awk '{print $4}')
  local available_gb=$(( ${available_kb:-0} / 1024 / 1024 ))
  local required_gb=15
  [[ "$TIER" == "bf16" ]] && required_gb=25
  [[ "$TIER" == "gguf" ]] && required_gb=14

  if [ "$available_gb" -lt "$required_gb" ]; then
    log_warn "Available disk space: ${available_gb}GB, required: ${required_gb}GB"
    log_warn "Continuing anyway - download may fail if insufficient space"
  else
    log_info "Disk space OK: ${available_gb}GB available (${required_gb}GB required)"
  fi
}

# Setup ComfyUI
setup_comfyui() {
  log_info "Setting up ComfyUI in $INSTALL_DIR..."
  
  mkdir -p "$INSTALL_DIR"
  
  if [ ! -d "$INSTALL_DIR/ComfyUI" ]; then
    log_info "Cloning ComfyUI..."
    git clone "$COMFYUI_REPO" "$INSTALL_DIR/ComfyUI"
  else
    log_info "ComfyUI directory exists, updating..."
    git -C "$INSTALL_DIR/ComfyUI" pull --ff-only 2>/dev/null || log_warn "Could not update ComfyUI"
  fi
  
  # Setup venv
  if [ ! -d "$INSTALL_DIR/venv" ]; then
    log_info "Creating Python virtual environment..."
    python3 -m venv "$INSTALL_DIR/venv" 2>/dev/null || python -m venv "$INSTALL_DIR/venv"
  fi
  
  source "$INSTALL_DIR/venv/bin/activate"
  
  log_info "Installing PyTorch..."
  if [ "$(uname -s)" == "Darwin" ]; then
    pip install torch torchvision -q
  else
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124 -q
  fi
  
  log_info "Installing ComfyUI dependencies..."
  pip install -r "$INSTALL_DIR/ComfyUI/requirements.txt" -q

  # GGUF 티어(Apple)는 ComfyUI-GGUF 커스텀 노드 필요
  if [ "${TIER:-}" == "gguf" ]; then
    log_info "Installing ComfyUI-GGUF node (required on Apple Silicon)..."
    if [ ! -d "$INSTALL_DIR/ComfyUI/custom_nodes/ComfyUI-GGUF" ]; then
      git clone https://github.com/city96/ComfyUI-GGUF.git "$INSTALL_DIR/ComfyUI/custom_nodes/ComfyUI-GGUF"
    else
      git -C "$INSTALL_DIR/ComfyUI/custom_nodes/ComfyUI-GGUF" pull --ff-only 2>/dev/null || true
    fi
    pip install -q gguf sentencepiece
  fi
}

# Download models
download_models() {
  log_info "Downloading Z-Image Turbo models (tier: $TIER)..."
  
  mkdir -p "$INSTALL_DIR/ComfyUI/models/diffusion_models"
  mkdir -p "$INSTALL_DIR/ComfyUI/models/text_encoders"
  mkdir -p "$INSTALL_DIR/ComfyUI/models/vae"
  
  local GGUF_BASE="https://huggingface.co/jayn7/Z-Image-Turbo-GGUF/resolve/main"
  local TE_GGUF_BASE="https://huggingface.co/worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF/resolve/main"

  # "저장경로|다운로드URL" 쌍 — 티어별 구성
  local files_to_download
  if [ "$TIER" == "bf16" ]; then
    files_to_download=(
      "diffusion_models/z_image_turbo_bf16.safetensors|$MODELS_BASE/diffusion_models/z_image_turbo_bf16.safetensors"
      "text_encoders/qwen_3_4b.safetensors|$MODELS_BASE/text_encoders/qwen_3_4b.safetensors"
      "vae/ae.safetensors|$MODELS_BASE/vae/ae.safetensors"
    )
  elif [ "$TIER" == "gguf" ]; then
    files_to_download=(
      "diffusion_models/z_image_turbo-Q6_K.gguf|$GGUF_BASE/z_image_turbo-Q6_K.gguf"
      "text_encoders/Qwen_3_4b-Q8_0.gguf|$TE_GGUF_BASE/Qwen_3_4b-Q8_0.gguf"
      "vae/ae.safetensors|$MODELS_BASE/vae/ae.safetensors"
    )
  else
    files_to_download=(
      "diffusion_models/z_image_turbo_int8_convrot.safetensors|$MODELS_BASE/diffusion_models/z_image_turbo_int8_convrot.safetensors"
      "text_encoders/qwen_3_4b_fp8_mixed.safetensors|$MODELS_BASE/text_encoders/qwen_3_4b_fp8_mixed.safetensors"
      "vae/ae.safetensors|$MODELS_BASE/vae/ae.safetensors"
    )
  fi

  for entry in "${files_to_download[@]}"; do
    local file="${entry%%|*}"
    local url="${entry##*|}"
    local dir="${file%/*}"
    local filename="${file##*/}"
    local target="$INSTALL_DIR/ComfyUI/models/$file"
    
    if [ -f "$target" ]; then
      local actual_size=$(stat -f%z "$target" 2>/dev/null || stat -c%s "$target" 2>/dev/null)
      log_info "File exists: $filename ($(numfmt --to=iec-i --suffix=B $actual_size 2>/dev/null || echo $actual_size bytes))"
      continue
    fi
    
    log_info "Downloading $filename..."
    curl -L -C - --progress-bar -o "$target" "$url" || log_error "Failed to download $filename"
  done
}

# Create run script
create_run_script() {
  log_info "Creating run script..."
  
  cat > "$INSTALL_DIR/run.sh" << 'RUNSCRIPT'
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/venv/bin/activate"
python "$SCRIPT_DIR/ComfyUI/main.py" --listen 127.0.0.1 --port 8188 --enable-cors-header "*"
RUNSCRIPT
  
  chmod +x "$INSTALL_DIR/run.sh"
  log_success "Run script created at $INSTALL_DIR/run.sh"
}

# Main
main() {
  echo -e "${BLUE}================================================${NC}"
  echo -e "${BLUE}  Z-Image Turbo Local Installation${NC}"
  echo -e "${BLUE}  (Apache 2.0, runs fully on-device)${NC}"
  echo -e "${BLUE}================================================${NC}"
  echo ""
  
  detect_hardware
  check_prereqs
  setup_comfyui
  download_models
  create_run_script
  
  echo ""
  echo -e "${GREEN}================================================${NC}"
  echo -e "${GREEN}  Installation Complete!${NC}"
  echo -e "${GREEN}================================================${NC}"
  echo ""
  echo "Next steps:"
  echo "1. Start ComfyUI:"
  echo "   bash $INSTALL_DIR/run.sh"
  echo ""
  echo "2. Open Cinlan Studio and:"
  echo "   - Connect to localhost:8188"
  echo "   - Select 'Z-Image Turbo (Local · Free)'"
  echo ""
  echo "3. Generate images locally, free and private!"
  echo ""
}

main
