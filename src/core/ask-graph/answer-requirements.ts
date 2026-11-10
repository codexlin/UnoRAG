import type { JudgeAnswerRequirements } from "../ai/structured-output";
import { stripFilenameReferences } from "../retrieval/document-constraints";

/** Describe requested precision, never whether the evidence meets it. */
export function deriveAnswerRequirements(
	question: string,
): JudgeAnswerRequirements {
	const content = stripFilenameReferences(question).replace(
		/(?:不需要|无需|不要|不要求)[^，,。；;？?]{0,40}(?:步骤|细节|方法|算法|检查项)/gu,
		"",
	);
	const detailed =
		/(?:具体检查项|详细检查项|校验算法|检验算法|操作步骤|实施步骤|配置步骤|详细步骤|详细流程|具体方法|具体步骤|(?:如何|怎么).{0,8}(?:校验|检查|验证|配置))/u.test(
			content,
		);
	const named =
		/(?:什么|哪(?:项|些|种|类)).{0,10}(?:检查|措施|材料|手续|验证|校验)|(?:检查|措施|要求|材料|手续|验证|校验).{0,8}名称|(?:用|采用|使用|通过)(?:什么|哪(?:些|种|类))机制/u.test(
			content,
		);
	const otherFields =
		/(?:多久|几天|何时|什么时候|谁|哪位|地点|地址|街道|门牌|金额|单价|价格|时限|期限|上限|下限|数量|多少|哪一天|为什么)/u.test(
			content,
		);
	const destination =
		!/(?:地址|街道|门牌|楼层|坐标)/u.test(content) &&
		/(?:接收|收件|受理|递交|提交)(?:材料)?(?:的)?(?:地点|处所)/u.test(content);
	return {
		granularity: detailed
			? "procedure_details"
			: named && !otherFields
				? "named_requirement"
				: "unspecified",
		formal_name_required: /(?:正式|法定|标准)名称/u.test(content),
		...(destination ? { location_precision: "designated_destination" } : {}),
	};
}
