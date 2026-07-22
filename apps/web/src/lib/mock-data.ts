export type MockLibrary = {
	id: string;
	name: string;
	docCount: number;
	readyCount: number;
	updatedAt: string;
	status: "ready" | "indexing" | "empty";
};

export type MockCitation = {
	id: string;
	index: number;
	title: string;
	page?: string;
	snippet: string;
	score: number;
};

export type MockTurn = {
	id: string;
	question: string;
	answer: string;
	citations: MockCitation[];
};

export const MOCK_LIBRARIES: MockLibrary[] = [
	{
		id: "lib-hr",
		name: "人事制度库",
		docCount: 12,
		readyCount: 12,
		updatedAt: "今天 14:20",
		status: "ready",
	},
	{
		id: "lib-eng",
		name: "工程手册",
		docCount: 8,
		readyCount: 5,
		updatedAt: "昨天",
		status: "indexing",
	},
	{
		id: "lib-empty",
		name: "新品说明（草稿）",
		docCount: 0,
		readyCount: 0,
		updatedAt: "3 天前",
		status: "empty",
	},
];

export const MOCK_DEMO_TURN: MockTurn = {
	id: "turn-1",
	question: "病假需要在几天内补交证明？",
	answer:
		"根据现行人事制度，病假须于返岗后三个工作日内补交证明材料，并由直属主管确认。逾期未补交的，可按事假或旷工规则处理（以制度原文为准）。",
	citations: [
		{
			id: "c1",
			index: 1,
			title: "员工手册-休假篇.pdf",
			page: "p.12",
			snippet: "病假须于返岗后三个工作日内补交证明材料，并由直属主管确认……",
			score: 0.91,
		},
		{
			id: "c2",
			index: 2,
			title: "考勤管理细则.docx",
			page: "§3.2",
			snippet: "未能按期提交病假证明的，人力资源部有权按事假或旷工规则核算……",
			score: 0.78,
		},
	],
};
