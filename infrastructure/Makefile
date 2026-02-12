SHELL := /bin/bash
TF ?= terraform
TF_DIR ?= .

.PHONY: init plan apply destroy fmt validate smoke-test

init:
	$(TF) -chdir=$(TF_DIR) init

plan:
	$(TF) -chdir=$(TF_DIR) plan

apply:
	$(TF) -chdir=$(TF_DIR) apply

destroy:
	$(TF) -chdir=$(TF_DIR) destroy

fmt:
	$(TF) -chdir=$(TF_DIR) fmt -recursive

validate:
	$(TF) -chdir=$(TF_DIR) validate

smoke-test:
	bash ./scripts/smoke-test.sh
