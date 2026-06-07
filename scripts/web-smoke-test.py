import os

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 412, "height": 915})
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        expect(page.get_by_text("MARD 豆仓")).to_be_visible()
        expect(page.get_by_text("豆仓", exact=True)).to_be_visible()

        search = page.get_by_label("色号搜索")
        page.get_by_text("A", exact=True).first.click()
        expect(search).to_have_value("A")
        search.click()
        expect(page.get_by_label("输入数字9")).to_have_count(0)
        search.fill("A9")
        expect(search).to_have_value("A9")
        search.fill("a9")
        expect(search).to_have_value("A9")
        expect(page.get_by_text("A9").first).to_be_visible()
        search.fill("浅棕")
        expect(page.get_by_text("G2").first).to_be_visible()
        page.get_by_text("G2").first.click()
        expect(page.get_by_text("浅棕").first).to_be_visible()
        page.get_by_text("份数（当前每份1000颗）").click()
        page.get_by_label("每份颗数").fill("1200")
        page.get_by_text("保存", exact=True).click()
        page.get_by_label("份数").fill("2")
        page.get_by_label("按份增加").click()
        expect(page.get_by_text("G2 已按 2 份 × 1200 颗增加 2400 颗")).to_be_visible()
        expect(page.get_by_text("撤销操作", exact=True)).to_be_visible()
        page.get_by_label("按份增加").click()
        page.get_by_text("撤销操作", exact=True).click()
        expect(page.get_by_text("已撤销操作", exact=True)).to_be_visible()
        page.get_by_text("加入采购清单", exact=True).click()
        expect(page.get_by_text("G2 已加入「默认采购表」×1")).to_be_visible()

        page.get_by_text("图纸", exact=True).click()
        page.get_by_placeholder("例如：小熊挂件").fill("Web 测试图纸")
        page.get_by_text("新建", exact=True).click()
        expect(page.get_by_text("已创建图纸项目")).to_be_visible()
        expect(page.get_by_text("上传并裁剪图纸", exact=True)).to_be_visible()
        expect(page.get_by_text("识别裁剪图", exact=True)).to_be_visible()
        page.get_by_label("色号").fill("G2")
        page.get_by_label("需要颗数").fill("2444")
        page.get_by_text("加入图纸用量", exact=True).click()
        expect(page.get_by_text("需要 2444 · 库存 2400")).to_be_visible()

        page.get_by_text("采购", exact=True).click()
        expect(page.get_by_text("G2×1", exact=True)).to_be_visible()
        page.get_by_label("采购表名称").fill("6月补豆")
        page.get_by_text("新建", exact=True).click()
        expect(page.get_by_text("已新建采购表")).to_be_visible()
        page.get_by_label("采购每份颗数").fill("1200")
        page.get_by_label("采购色号").fill("G3")
        page.get_by_label("采购颗数").fill("1444")
        page.get_by_text("加入采购表", exact=True).click()
        expect(page.get_by_text("G3×2", exact=True)).to_be_visible()
        expect(page.get_by_text("选中图纸库存对比", exact=True)).to_be_visible()
        expect(page.get_by_text("需要 2444 · 库存 2400")).to_be_visible()

        page.get_by_text("豆仓", exact=True).click()
        page.get_by_label("选择采购表").click()
        expect(page.get_by_text("默认采购表", exact=True)).to_be_visible()
        expect(page.get_by_text("6月补豆", exact=True).first).to_be_visible()
        page.get_by_text("加入采购清单", exact=True).click()
        expect(page.get_by_text("G2 已加入「6月补豆」×1")).to_be_visible()

        page.get_by_text("设置", exact=True).click()
        expect(page.get_by_text("历史操作", exact=True)).to_be_visible()
        expect(page.get_by_text("导出备份文件", exact=True)).to_be_visible()
        page.get_by_text("清空本地数据", exact=True).click()
        expect(page.get_by_text("3 秒后可确认清空")).to_be_visible()

        browser.close()
        print("web smoke tests passed")


if __name__ == "__main__":
    main()
