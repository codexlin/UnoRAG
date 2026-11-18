const FORM =
	/(?:申请表|登记表|表单|申请单|登记单|application form|registration form)/i;
const WORKFLOW_CHECKLIST =
	/(?:检查|操作|发布|上线|运维|巡检|交付|维护|工作|备份)清单/u;
const TABLE_STRUCTURE =
	/(?:表格|表中|表内|明细表|台账|表头|列名|多少行|\brows?\b)/iu;
const TABLE_OPERATION =
	/(?:合计|总计|总额|总和|汇总|平均|计数|统计|分组|排序|排名|筛选|过滤|关联|连接|所有|全部|逐行|最多|最少|最高|最低|最大|最小|最长|最短|超过|大于|小于|不低于|不高于|至少|至多|前\s*\d+|有几[个人条项份张次]|多少[个人条项行份张次]|第\s*[一二三四五六七八九十\d]+\s*[行列]|序号|[<>≤≥]|\b(?:sum|average|count|group|sort|filter|join|top|min|max)\b)/i;
const DERIVED_CALCULATION =
	/(?:复合增长率|年均复合|年均增长|增长率|增速|同比|环比|涨跌幅|变化率|市盈率|静态市盈率|动态市盈率|市净率|市销率|净资产收益率|总资产收益率|毛利率|净利率|资产负债率|流动比率|速动比率|周转率|覆盖率|杠杆率|股息率|分红率|占比|比例|百分比|比率|比值|倍数|多少倍|差额|差值|换算|折算|除以|相除|乘以|每股|人均|\b(?:cagr|yoy|qoq|mom|pe|pb|ps|roe|roa|roic|eps|ebitda|ratio|percentage)\b)/iu;

/** Derived financial/ratio calculations require multi-step reasoning rather than single-table row lookup. */
export function isDerivedCalculationQuestion(question: string): boolean {
	return DERIVED_CALCULATION.test(question);
}

/** A filled form field can be evidence in OCR prose, not necessarily a table dataset. */
export function isFormFieldLookup(question: string): boolean {
	return FORM.test(question) && !TABLE_OPERATION.test(question);
}

export function isFormTableOperation(question: string): boolean {
	return FORM.test(question) && TABLE_OPERATION.test(question);
}

export function isProseChecklistLookup(question: string): boolean {
	return (
		WORKFLOW_CHECKLIST.test(question) &&
		!TABLE_STRUCTURE.test(question) &&
		!TABLE_OPERATION.test(question)
	);
}
