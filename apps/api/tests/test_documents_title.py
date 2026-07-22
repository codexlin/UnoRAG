from app.services.documents import clean_display_title, infer_page_label


def test_clean_display_title_strips_student_id_prefix() -> None:
	assert clean_display_title("学号：202204043108") == "202204043108"
	assert clean_display_title("学号:202204043108-说明书") == "202204043108-说明书"


def test_clean_display_title_keeps_meaningful_name() -> None:
	assert clean_display_title("毕业设计说明书") == "毕业设计说明书"


def test_infer_page_label() -> None:
	text = "## Page 1\n\nhello\n\n## Page 3\n\n张家龙是指导教师"
	# legacy：多页标记用范围，避免误标为「最后一个 Page」
	assert infer_page_label(text) == "p.1-3"
	assert infer_page_label("## Page 2\n\nonly") == "p.2"
