import React from "react";
import { Composition } from "remotion";
import { UnoRAGHeroFilm } from "./UnoRAGHeroFilm";
import { UnoRAGLibraryFilm } from "./UnoRAGLibraryFilm";
import { UnoRAGTraceFilm } from "./UnoRAGTraceFilm";

export const RemotionRoot: React.FC = () => {
	return (
		<>
			<Composition
				id="UnoRAGHeroFilm"
				component={UnoRAGHeroFilm}
				durationInFrames={360}
				fps={30}
				width={1440}
				height={810}
				defaultProps={{ locale: "en" as const, theme: "light" as const }}
			/>
			<Composition
				id="UnoRAGLibraryFilm"
				component={UnoRAGLibraryFilm}
				durationInFrames={270}
				fps={30}
				width={1440}
				height={860}
				defaultProps={{ locale: "en" as const, theme: "light" as const }}
			/>
			<Composition
				id="UnoRAGTraceFilm"
				component={UnoRAGTraceFilm}
				durationInFrames={270}
				fps={30}
				width={1080}
				height={900}
				defaultProps={{ locale: "en" as const, theme: "light" as const }}
			/>
		</>
	);
};
