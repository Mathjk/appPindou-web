import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")
REPO_ROOT = Path(__file__).resolve().parents[1]
STORAGE_KEY = "appPindou:data:v1"


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


IMAGE_PATH = resolve_test_image("OCR_TEXT_REFINE_TEST_IMAGE", "pdpng1.png")


def main():
    image = Path(IMAGE_PATH)
    captured = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)
        page.route(
            "https://api.ocr.space/parse/image",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body='{"ParsedResults":[{"ParsedText":"G02 x12"}],"IsErroredOnProcessing":false}',
            ),
        )

        def handle_deepseek(route):
            payload = route.request.post_data_json
            captured["authorization"] = route.request.headers.get("authorization", "")
            captured["model"] = payload.get("model")
            captured["user_text"] = payload.get("messages", [{}])[-1].get("content", "")
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": '[{"code":"G2","quantity":34}]',
                                }
                            }
                        ]
                    }
                ),
            )

        page.route("https://api.deepseek.com/chat/completions", handle_deepseek)
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        page.get_by_text("设置", exact=True).click()
        page.get_by_label("文本 API Key").fill("test-deepseek-key")
        page.get_by_label("文本模型").fill("deepseek-v4-flash")
        page.get_by_text("保存 OCR 设置", exact=True).click()
        expect(page.get_by_text("OCR 接口设置已保存", exact=True)).to_be_visible(timeout=5000)

        page.get_by_text("图纸", exact=True).click()
        page.get_by_placeholder("例如：小熊挂件").fill("DeepSeek 文本整理测试")
        page.get_by_text("新建", exact=True).click()
        with page.expect_file_chooser() as file_chooser_info:
            page.get_by_text("上传并裁剪图纸", exact=True).click()
        file_chooser_info.value.set_files(str(image))

        expect(page.get_by_text("裁剪图纸", exact=True)).to_be_visible(timeout=15000)
        page.get_by_text("确认裁剪并识别", exact=True).click()
        expect(page.get_by_text("文本模型 deepseek-v4-flash 已参与整理，并采用文本模型结果", exact=False).first).to_be_visible(timeout=15000)
        page.wait_for_timeout(1000)

        assert captured["authorization"] == "Bearer test-deepseek-key", f"Unexpected auth header: {captured}"
        assert captured["model"] == "deepseek-v4-flash", f"Unexpected model: {captured}"
        assert "G02 x12" in captured["user_text"], f"OCR text was not sent to text model: {captured}"

        data = page.evaluate(f"JSON.parse(localStorage.getItem('{STORAGE_KEY}'))")
        items = {item["code"]: item["quantity"] for item in data["projects"][0]["items"]}
        assert items == {"G2": 34}, f"Text model result should be adopted: {items}"

        browser.close()
        print("ocr text refine tests passed")


if __name__ == "__main__":
    main()
