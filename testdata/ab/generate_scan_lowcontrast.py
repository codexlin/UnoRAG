#!/usr/bin/env python3
"""Generate a real image-only, low-contrast Chinese scan fixture."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

PAGE_SIZE = (1240, 1754)
BACKGROUND = (244, 244, 241)
TEXT = (104, 104, 100)
MUTED = (126, 126, 121)
FONT_CANDIDATES = (
	Path("/System/Library/Fonts/STHeiti Medium.ttc"),
	Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
	Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
)


def _font(size: int) -> ImageFont.FreeTypeFont:
	for path in FONT_CANDIDATES:
		if path.is_file():
			return ImageFont.truetype(str(path), size=size)
	raise RuntimeError("no supported CJK font found")


TITLE = _font(44)
SUBTITLE = _font(30)
HEADING = _font(29)
BODY = _font(23)
SMALL = _font(19)


def _new_page() -> tuple[Image.Image, ImageDraw.ImageDraw]:
	page = Image.new("RGB", PAGE_SIZE, BACKGROUND)
	return page, ImageDraw.Draw(page)


def _draw_centered(
	draw: ImageDraw.ImageDraw,
	text: str,
	y: int,
	font: ImageFont.FreeTypeFont,
	fill: tuple[int, int, int] = TEXT,
) -> int:
	box = draw.textbbox((0, 0), text, font=font)
	x = (PAGE_SIZE[0] - (box[2] - box[0])) // 2
	draw.text((x, y), text, font=font, fill=fill)
	return y + (box[3] - box[1])


def _draw_wrapped(
	draw: ImageDraw.ImageDraw,
	text: str,
	*,
	x: int,
	y: int,
	width: int,
	font: ImageFont.FreeTypeFont = BODY,
	fill: tuple[int, int, int] = TEXT,
	line_gap: int = 15,
) -> int:
	lines: list[str] = []
	line = ""
	for char in text:
		candidate = f"{line}{char}"
		if line and draw.textlength(candidate, font=font) > width:
			lines.append(line)
			line = char
		else:
			line = candidate
	if line:
		lines.append(line)
	line_height = draw.textbbox((0, 0), "滨海Ag", font=font)[3] + line_gap
	for item in lines:
		draw.text((x, y), item, font=font, fill=fill)
		y += line_height
	return y


def _section(
	draw: ImageDraw.ImageDraw,
	title: str,
	paragraphs: list[str],
	*,
	y: int,
) -> int:
	draw.text((105, y), title, font=HEADING, fill=TEXT)
	y += 58
	for paragraph in paragraphs:
		y = _draw_wrapped(draw, paragraph, x=112, y=y, width=1015)
		y += 22
	return y + 12


def _scan_effect(page: Image.Image) -> Image.Image:
	# Keep the document OCR-readable while emulating a pale office scan.
	noise = Image.effect_noise(PAGE_SIZE, 6).convert("RGB")
	page = Image.blend(page, noise, 0.025)
	return page.filter(ImageFilter.GaussianBlur(radius=0.28))


def _page_one() -> Image.Image:
	page, draw = _new_page()
	y = 105
	y = _draw_centered(draw, "滨海市智慧交通管理系统建设项目", y, TITLE)
	y = _draw_centered(draw, "竣工验收报告", y + 22, TITLE)
	y = _draw_centered(draw, "项目编号：BH-ZHJC-2026-0042", y + 55, SUBTITLE)
	y = _draw_centered(draw, "验收日期：2026年07月15日", y + 26, BODY, MUTED)

	y += 100
	y = _section(
		draw,
		"一、项目概况",
		[
			"本项目于2024年3月正式立项，建设内容包括交通信号控制、视频监控、交通诱导、数据交换和综合管理平台等子系统。",
			"项目总投资额为人民币壹亿贰仟叁佰万元整（¥123,000,000）。项目自2024年6月开工，于2026年5月完成全部建设任务，建设周期24个月。",
			"经审计，实际完成投资额为人民币壹亿壹仟玖佰柒拾万元整（¥119,700,000），较概算节约约2.66%。",
		],
		y=y,
	)
	y = _section(
		draw,
		"二、建设完成情况",
		[
			"项目完成86个核心路口升级、12个交通枢纽改造和3个数据中心节点建设；接入信号控制路口1,240处、视频监控点位580处、交通诱导屏46块。",
			"系统完成试运行和第三方检测，功能、性能、安全性及稳定性均满足设计文件和合同约定。",
		],
		y=y,
	)
	draw.text((1000, 1640), "第 1 页 / 共 2 页", font=SMALL, fill=MUTED)
	return _scan_effect(page)


def _page_two() -> Image.Image:
	page, draw = _new_page()
	y = 105
	y = _section(
		draw,
		"三、主要技术指标",
		[
			"信号控制子系统：路口联网率100%，交通信号方案下发成功率99.97%，平均响应时间不高于1.2秒。",
			"视频监控子系统：在线率不低于96.8%，录像完整率不低于99.2%，关键点位识别准确率不低于98.5%。",
			"数据交换平台：日均处理数据超过200万条，核心接口API调用成功率不低于99.95%。",
		],
		y=y,
	)
	y = _section(
		draw,
		"四、验收结论",
		[
			"验收专家组审阅了项目资料，听取建设、施工、监理和检测单位汇报，并对系统功能进行了现场抽查。",
			"专家组一致认为项目已完成合同约定的建设内容，技术指标符合设计要求，文档资料齐全，系统运行稳定，同意通过竣工验收。",
			"验收专家组评定等级：优良。用户满意度调查评分：4.63分（满分5分）。",
		],
		y=y,
	)
	y = _section(
		draw,
		"五、后续要求",
		[
			"建设单位应持续完善运维制度，加强平台安全巡检和数据备份，并在验收后五个工作日内完成剩余资料归档。",
		],
		y=y,
	)
	draw.line((120, y + 45, 515, y + 45), fill=MUTED, width=2)
	draw.line((715, y + 45, 1110, y + 45), fill=MUTED, width=2)
	draw.text((205, y + 65), "建设单位（盖章）", font=SMALL, fill=MUTED)
	draw.text((800, y + 65), "验收专家组", font=SMALL, fill=MUTED)
	draw.text((1000, 1640), "第 2 页 / 共 2 页", font=SMALL, fill=MUTED)
	return _scan_effect(page)


def main() -> None:
	output = Path(__file__).with_name("scan-lowcontrast.pdf")
	pages = [_page_one(), _page_two()]
	pages[0].save(
		output,
		format="PDF",
		save_all=True,
		append_images=pages[1:],
		resolution=150,
		quality=88,
	)
	print(output)


if __name__ == "__main__":
	main()
