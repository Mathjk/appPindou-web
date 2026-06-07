import base64
import os
from pathlib import Path
from urllib.parse import parse_qs

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")
REPO_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = REPO_ROOT / ".tmp-crop"


def resolve_test_image(env_name, file_name):
    explicit = os.environ.get(env_name)
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.extend(
        [
            REPO_ROOT / "test-fixtures" / file_name,
            REPO_ROOT / "temp" / file_name,
            REPO_ROOT.parent / "appPindou" / "temp" / file_name,
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"Missing test image {file_name}. Set {env_name} or place it in test-fixtures/.")


IMAGE_PATH = resolve_test_image("OCR_PIPELINE_TEST_IMAGE", "pdpng2.png")


def image_size(raw):
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if raw.startswith(b"\xff\xd8"):
        index = 2
        while index < len(raw):
            while index < len(raw) and raw[index] == 0xFF:
                index += 1
            marker = raw[index]
            index += 1
            length = int.from_bytes(raw[index : index + 2], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(raw[index + 3 : index + 5], "big")
                width = int.from_bytes(raw[index + 5 : index + 7], "big")
                return width, height
            index += length
    raise ValueError("Unsupported image format")


def decode_data_url(data_url):
    _, encoded = data_url.split(",", 1)
    return base64.b64decode(encoded)


def main():
    image = Path(IMAGE_PATH)
    if not image.exists():
        raise FileNotFoundError(f"Missing OCR pipeline test image: {image}")

    captured = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)

        def handle_ocr(route):
            body = route.request.post_data or ""
            params = parse_qs(body)
            data_url = params.get("base64Image", [""])[0]
            raw = decode_data_url(data_url)
            width, height = image_size(raw)
            captured["width"] = width
            captured["height"] = height
            TMP_DIR.mkdir(exist_ok=True)
            (TMP_DIR / "ocr-request-image.png").write_bytes(raw)
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"ParsedResults":[{"ParsedText":"G2 12"}],"IsErroredOnProcessing":false}',
            )

        page.route("https://api.ocr.space/parse/image", handle_ocr)
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        page.get_by_text("图纸", exact=True).click()
        page.get_by_placeholder("例如：小熊挂件").fill("OCR 图片链路测试")
        page.get_by_text("新建", exact=True).click()
        with page.expect_file_chooser() as file_chooser_info:
            page.get_by_text("上传并裁剪图纸", exact=True).click()
        file_chooser_info.value.set_files(str(image))

        expect(page.get_by_text("裁剪图纸", exact=True)).to_be_visible(timeout=15000)
        page.get_by_text("确认裁剪并识别", exact=True).click()
        expect(page.get_by_text("OCR 已识别 1 个颜色", exact=False).first).to_be_visible(timeout=15000)
        expect(page.get_by_text("上方预览为 OCR 实际识别图", exact=False)).to_be_visible()

        assert captured, "OCR request was not captured"
        width = captured["width"]
        height = captured["height"]
        aspect = max(width / height, height / width)
        assert aspect <= 3.7, f"OCR image is still too extreme: {width}x{height}, aspect={aspect:.2f}"
        assert max(width, height) >= 2200, f"OCR image long side is too small after preparation: {width}x{height}"
        assert min(width, height) >= 650, f"OCR image short side is too small after padding: {width}x{height}"

        browser.close()
        print(f"ocr image pipeline tests passed ({width}x{height})")


if __name__ == "__main__":
    main()
