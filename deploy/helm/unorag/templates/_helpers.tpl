{{/*
Expand the name of the chart.
*/}}
{{- define "unorag.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* OpenTelemetry environment shared by web and DBOS processes. */}}
{{- define "unorag.otelEnv" -}}
{{- $root := index . 0 -}}
{{- $serviceName := index . 1 -}}
- name: OTEL_SDK_DISABLED
  value: {{ ternary "false" "true" $root.Values.observability.otel.enabled | quote }}
{{- if $root.Values.observability.otel.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ $root.Values.observability.otel.endpoint | quote }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: "http/protobuf"
- name: OTEL_TRACES_SAMPLER
  value: {{ $root.Values.observability.otel.tracesSampler | quote }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ $root.Values.observability.otel.tracesSamplerArg | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ $serviceName | quote }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  valueFrom:
    secretKeyRef:
      name: {{ include "unorag.secretName" $root }}
      key: {{ $root.Values.observability.otel.headersSecretKey | quote }}
      optional: true
{{- end }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "unorag.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "unorag.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "unorag.labels" -}}
helm.sh/chart: {{ include "unorag.chart" . }}
{{ include "unorag.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "unorag.selectorLabels" -}}
app.kubernetes.io/name: {{ include "unorag.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "unorag.secretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- printf "%s-runtime" (include "unorag.fullname" .) }}
{{- end }}
{{- end }}

{{- define "unorag.documentsPvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- printf "%s-documents" (include "unorag.fullname" .) }}
{{- end }}
{{- end }}
