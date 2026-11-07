const FORM =
	/(?:申请表|登记表|表单|申请单|登记单|application form|registration form)/i;
const WORKFLOW_CHECKLIST =
	/(?:检查|操作|发布|上线|运维|巡检|交付|维护|工作)清单/u;
const TABLE_OPERATION =
	/(?:合计|总计|总额|总和|汇总|平均|计数|统计|分组|排序|排名|筛选|过滤|关联|连接|所有|全部|逐行|最多|最少|最高|最低|最大|最小|最长|最短|超过|大于|小于|不低于|不高于|至少|至多|前\s*\d+|有几[个人条项份张次]|多少[个人条项行份张次]|第\s*[一二三四五六七八九十\d]+\s*[行列]|序号|[<>≤≥]|\b(?:sum|average|count|group|sort|filter|join|top|min|max)\b)/i;

/** A filled form field can be evidence in OCR prose, not necessarily a table dataset. */
export function isFormFieldLookup(question: string): boolean {
	return FORM.test(question) && !TABLE_OPERATION.test(question);
}

export function isFormTableOperation(question: string): boolean {
	return FORM.test(question) && TABLE_OPERATION.test(question);
}

export function isProseChecklistLookup(question: string): boolean {
	return WORKFLOW_CHECKLIST.test(question) && !TABLE_OPERATION.test(question);
}
