# Define base variables
$baseUrl = "http://localhost:8080/engine-rest"
$claimID = "600550263"
$diagramFolder = ".\diagrams"

if (-not (Test-Path -Path $diagramFolder)) {
    New-Item -ItemType Directory -Path $diagramFolder -Force | Out-Null
} else {
    # Remove all contents inside the folder
    Get-ChildItem -Path $diagramFolder -File | Remove-Item -Force
}

# Credentials
$username = "devteam"
$password = "password"
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential ($username, $securePassword)

# Step 1: Get process instance by business key
$instanceUrl = "$baseUrl/history/process-instance?processInstanceBusinessKey=$claimID"
$instanceResponse = Invoke-RestMethod -Uri $instanceUrl -Method Get -Credential $credential

foreach ($instance in $instanceResponse) {
    $processInstanceId = $instance.id
    $processDefinitionId = $instance.processDefinitionId
    $processKey = $instance.processDefinitionKey

    Write-Output "`n🎯 Process Instance ID: $processInstanceId"
    Write-Output "📘 Process Definition ID: $processDefinitionId"

    # Step 2: Get historic activity instances
    $activityUrl = "$baseUrl/history/activity-instance?processInstanceId=$processInstanceId"
    $activities = Invoke-RestMethod -Uri $activityUrl -Method Get -Credential $credential

    # Log executed activities
    Write-Output "`n🕵️ Executed Activities:"
    foreach ($activity in $activities) {
        Write-Output "- ID: $($activity.activityId), Type: $($activity.activityType), Name: $($activity.activityName)"
    }

    # Step 3: Get BPMN diagram XML
    $diagramUrl = "$baseUrl/process-definition/$processDefinitionId/xml"
    $diagram = Invoke-RestMethod -Uri $diagramUrl -Method Get -Credential $credential

    # Save BPMN file
    $bpmnFileName = "$processKey-$claimID.bpmn"
    $bpmnSavePath = "$diagramFolder\$bpmnFileName"
    $diagram.bpmn20Xml | Out-File -FilePath $bpmnSavePath -Encoding utf8
    Write-Output "`n📝 BPMN Diagram saved to: $bpmnSavePath"

    # Step 4: Save activity trace to JSON
    $activityIds = $activities | Select-Object -ExpandProperty activityId
    $bpmnJsonPath = "$diagramFolder\$processKey-$claimID.json"
    $bpmnTrace = [PSCustomObject]@{
        executedActivities = $activityIds
    }
    $bpmnTrace | ConvertTo-Json -Depth 2 | Out-File -FilePath $bpmnJsonPath -Encoding utf8
    Write-Output "`n📁 BPMN activity trace saved to: $bpmnJsonPath"

    # Step 5: Get decision instances for DMN
    $decisionUrl = "$baseUrl/history/decision-instance?processInstanceId=$processInstanceId"
    $decisionInstances = Invoke-RestMethod -Uri $decisionUrl -Method Get -Credential $credential

    foreach ($decision in $decisionInstances) {
        $decisionId = $decision.decisionDefinitionId
        $decisionKey = $decision.decisionDefinitionKey

        # Get DMN diagram XML
        $dmnUrl = "$baseUrl/decision-definition/$decisionId/xml"
        $dmnXml = Invoke-RestMethod -Uri $dmnUrl -Method Get -Credential $credential

        # Save DMN file
        $dmnFileName = "$decisionKey-$claimID.dmn"
        $dmnSavePath = "$diagramFolder\$dmnFileName"
        $dmnXml.dmnXml | Out-File -FilePath $dmnSavePath -Encoding utf8
        Write-Output "`n📊 DMN Diagram saved: $dmnSavePath"

        # Get DMN audit log
        $auditUrl = "$baseUrl/history/decision-instance/$decisionId/auditLog"
                try {
            $auditLog = Invoke-RestMethod -Uri $auditUrl -Method Get -Credential $credential
            $ruleIds = $auditLog.evaluatedOutputs | Select-Object -ExpandProperty ruleId
        } catch {
            Write-Warning "⚠️ No audit log found for decision ID: $decisionId"
            $ruleIds = @()
        }

        # Extract evaluated rule IDs
        $ruleIds = $auditLog.evaluatedOutputs | Select-Object -ExpandProperty ruleId
        $dmnJsonPath = "$diagramFolder\$decisionKey-$claimID.json"
        $dmnTrace = [PSCustomObject]@{
            evaluatedRules = $ruleIds
        }
        $dmnTrace | ConvertTo-Json -Depth 2 | Out-File -FilePath $dmnJsonPath -Encoding utf8
        Write-Output "`n📁 DMN rule trace saved to: $dmnJsonPath"
    }

    Write-Output "`n✅ Diagrams and traces ready. Open viewer.html in your browser and click to explore the process visually!"
}