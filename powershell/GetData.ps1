#region [================== SCRIPT HEADER AND PARAMETERS ==================]
<#
.SYNOPSIS
    Camunda Process Data Extraction Script for Business Process Analysis

.DESCRIPTION
    Retrieves BPMN process diagrams, DMN decision tables, and execution data from Camunda
    for a specific business key. Supports configurable run limiting to control processing scope
    and performance. Data is stored in memory via local server for secure PII handling.

.PARAMETER BusinessKey
    The business key to retrieve process data for (default: "600550372")

.PARAMETER Environment
    The target environment configuration to use (default: "local")

.PARAMETER MaxRuns
    Maximum number of workflow runs to process for performance control (default: 5)

.PARAMETER SessionId
    Unique session identifier for multi-tab support (optional, generates new session if not provided)
    
.EXAMPLE
    .\GetData.ps1 -BusinessKey "600407892" -Environment "local" -MaxRuns 10

.EXAMPLE
    .\GetData.ps1 -BusinessKey "600407892" -Environment "local" -SessionId "session_12345"

.NOTES
    Requires config-{Environment}.cfg file with BASE_URL, USERNAME, and PASSWORD settings.
    All data is stored in memory through the local server for PII protection.
    Use SessionId parameter to support multiple business processes in different browser tabs.
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$BusinessKey = "600550372",
    [Parameter(Mandatory=$false)]
    [string]$Environment = "local",
    [Parameter(Mandatory=$false)]
    [int]$MaxRuns = 5,
    [Parameter(Mandatory=$false)]
    [string]$SessionId = ""
)
#endregion

#region [================== CONFIGURATION MANAGEMENT ==================]
<#
.SYNOPSIS
    Load configuration settings from environment-specific config file
.DESCRIPTION
    Reads configuration from config-{Environment}.cfg file and validates required settings.
    Config file should contain BASE_URL, USERNAME, and PASSWORD settings.
.PARAMETER Environment
    The environment name to load configuration for (local, dev, test, uat, prod)
.RETURNS
    Hashtable containing configuration key-value pairs
#>
function Get-Configuration {
    param([string]$Environment)
    
    $configPath = ".\config-$Environment.cfg"
    $config = @{}
    
    if (-not (Test-Path -Path $configPath)) {
        Write-Error "Configuration file not found at: $configPath"
        Write-Error "Please create a config-$Environment.cfg file with BASE_URL, USERNAME, and PASSWORD settings."
        exit 1
    }
    
    try {
        $configLines = Get-Content -Path $configPath -ErrorAction Stop
        
        foreach ($line in $configLines) {
            if ($line.Trim() -eq "" -or ($line.Trim().StartsWith("#") -and -not ($line -match "^[^=]+=.*"))) {
                continue
            }
            
            if ($line -match "^([^=]+)=(.*)$") {
                $key = $matches[1].Trim()
                $value = $matches[2] -replace "^\s+", ""
                $config[$key] = $value
            }
        }
        
        $requiredKeys = @("BASE_URL", "USERNAME", "PASSWORD")
        foreach ($key in $requiredKeys) {
            if (-not $config.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($config[$key])) {
                Write-Error "Missing or empty required configuration setting: $key"
                exit 1
            }
        }
        
        return $config
    } catch {
        Write-Error "Error reading configuration file: $($_.Exception.Message)"
        exit 1
    }
}
#endregion

#region [================== WEB REQUEST UTILITIES ==================]
<#
.SYNOPSIS
    Enhanced Invoke-RestMethod with proxy support and certificate handling
.DESCRIPTION
    Wrapper around Invoke-RestMethod that adds proxy configuration, credential handling,
    and certificate validation control for different environments.
.PARAMETER Uri
    The URI to make the request to
.PARAMETER Method
    HTTP method (GET, POST, etc.)
.PARAMETER Credential
    Authentication credentials for the request
.PARAMETER ProxyServer
    Proxy server to use for the request
.PARAMETER ProxyCredential
    Credentials for proxy authentication
.PARAMETER Environment
    Environment name for conditional certificate handling
.RETURNS
    Response from the REST API call
#>
function Invoke-RestMethodWithProxy {
    param(
        [string]$Uri,
        [string]$Method = "GET",
        [System.Management.Automation.PSCredential]$Credential,
        [string]$ProxyServer,
        [System.Management.Automation.PSCredential]$ProxyCredential,
        [string]$Environment = "local"
    )
    
    $requestParams = @{
        Uri = $Uri
        Method = $Method
        Credential = $Credential
    }
    
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        if ($Environment -eq "local") {
            $requestParams.AllowUnencryptedAuthentication = $true
        }
        $requestParams.SkipCertificateCheck = $true
    }
    
    if (![string]::IsNullOrWhiteSpace($ProxyServer)) {
        $requestParams.Proxy = "http://$ProxyServer"
        $requestParams.ProxyUseDefaultCredentials = $false
        
        if ($ProxyCredential) {
            $requestParams.ProxyCredential = $ProxyCredential
        }
    }
    
    return Invoke-RestMethod @requestParams
}
#endregion

#region [================== CREDENTIAL SETUP ==================]
$config = Get-Configuration -Environment $Environment
$baseUrl = $config["BASE_URL"]
$username = $config["USERNAME"]
$password = $config["PASSWORD"]

# Create secure credentials using direct .NET method to avoid module loading issues
try {
    # Use direct .NET approach to avoid PowerShell Security module dependencies
    $securePassword = [System.Security.SecureString]::new()
    foreach ($char in $password.ToCharArray()) {
        $securePassword.AppendChar($char)
    }
    $credential = New-Object System.Management.Automation.PSCredential ($username, $securePassword)
    Write-Output "Credentials created successfully using direct .NET method"
} catch {
    Write-Error "Failed to create secure credentials: $($_.Exception.Message)"
    exit 1
}

# Setup proxy credentials if configured
$proxyCredential = $null
$proxyServer = $null

if ($config.ContainsKey("PROXY_SERVER") -and ![string]::IsNullOrWhiteSpace($config["PROXY_SERVER"])) {
    $proxyServer = $config["PROXY_SERVER"]
    
    if ($config.ContainsKey("PROXY_USERNAME") -and ![string]::IsNullOrWhiteSpace($config["PROXY_USERNAME"]) -and
        $config.ContainsKey("PROXY_PASSWORD") -and ![string]::IsNullOrWhiteSpace($config["PROXY_PASSWORD"])) {
        
        $proxyUsername = $config["PROXY_USERNAME"]
        $proxyPassword = $config["PROXY_PASSWORD"]
        
        try {
            # Use direct .NET approach for proxy credentials too
            $secureProxyPassword = [System.Security.SecureString]::new()
            foreach ($char in $proxyPassword.ToCharArray()) {
                $secureProxyPassword.AppendChar($char)
            }
            $proxyCredential = New-Object System.Management.Automation.PSCredential ($proxyUsername, $secureProxyPassword)
        } catch {
            Write-Error "Failed to create proxy credentials: $($_.Exception.Message)"
            exit 1
        }
    }
}
#endregion

#region [================== IN-MEMORY STORAGE FUNCTIONS ==================]
<#
.SYNOPSIS
    Store diagram or execution data in the local server's memory
.DESCRIPTION
    Sends diagram content (BPMN/DMN files) or execution data to the local server
    for in-memory storage. This prevents PII from being written to disk files.
.PARAMETER filename
    Name of the file to store in memory
.PARAMETER content
    Content of the file (XML, JSON, etc.)
.PARAMETER type
    Type of content (diagram, execution-data, variable-chunk, etc.)
.PARAMETER sessionId
    Session identifier for multi-tab support
.RETURNS
    Boolean indicating success or failure
#>
function Save-DiagramInMemory {
    param(
        [string]$filename,
        [string]$content,
        [string]$type = "diagram",
        [string]$sessionId = ""
    )
    
    try {
        $serverUrl = "http://localhost:3000/store-diagram"
        $body = @{
            filename = $filename
            content = $content
            type = $type
        }
        
        if (![string]::IsNullOrWhiteSpace($sessionId)) {
            $body.sessionId = $sessionId
        }
        
        $bodyJson = $body | ConvertTo-Json -Depth 10
        $headers = @{ 'Content-Type' = 'application/json' }
        
        Invoke-RestMethod -Uri $serverUrl -Method Post -Body $bodyJson -Headers $headers -ErrorAction Stop | Out-Null
        Write-Output "Stored in memory: $filename"
        
        if ($filename.EndsWith('.dmn')) { $global:dmnFilesStored++ }
        elseif ($filename.EndsWith('.json')) { $global:jsonFilesStored++ }
        elseif ($filename.EndsWith('.bpmn')) { $global:bpmnFilesStored++ }
        
        return $true
    } catch {
        Write-Warning "Failed to store $filename in memory: $($_.Exception.Message)"
        return $false
    }
}

<#
.SYNOPSIS
    Create a structured decision instance data object
.DESCRIPTION
    Builds a standardized data structure for DMN decision instance information
    including decision details, execution time, inputs, outputs, and rule information.
.PARAMETER DecisionDefinitionKey
    The key of the decision definition
.PARAMETER DecisionInstanceId
    Unique identifier for this decision instance
.PARAMETER DecisionName
    Human-readable name of the decision
.PARAMETER EvaluationTime
    When the decision was evaluated
.PARAMETER ProcessInstanceId
    Process instance that triggered this decision
.PARAMETER Inputs
    Array of input variables used in the decision
.PARAMETER Outputs
    Array of output values produced by the decision
.PARAMETER RuleIds
    Array of rule identifiers that were executed
.RETURNS
    PSCustomObject with structured decision instance data
#>
function New-DecisionInstanceData {
    param(
        [array]$RuleIds,
        [bool]$HasRuleIds,
        [bool]$HasAuditLog = $false,
        [object]$AuditData = $null,
        [object]$Inputs,
        [object]$Outputs,
        [string]$DecisionKey,
        [string]$DecisionId,
        [string]$DecisionName,
        [string]$ProcessKey,
        [string]$ProcessInstanceId,
        [string]$EvaluationTime
    )
    
    $executedRulesValue = if ($RuleIds.Count -eq 1) { $RuleIds[0] } 
                         elseif ($RuleIds.Count -eq 0) { @("decision-table") }
                         else { $RuleIds }
    
    return [PSCustomObject]@{
        executedRules = $executedRulesValue
        hasRuleIds = $HasRuleIds
        hasAuditLog = $HasAuditLog
        auditData = $AuditData
        inputs = $Inputs
        outputs = $Outputs
        instanceDetails = @{
            decisionDefinitionKey = $DecisionKey
            decisionDefinitionId = $DecisionId
            decisionDefinitionName = $DecisionName
            processDefinitionKey = $ProcessKey
            processInstanceId = $ProcessInstanceId
            evaluationTime = $EvaluationTime
        }
    }
}
#endregion

#region [================== MAIN PROCESSING LOGIC ==================]
$global:dmnFilesStored = 0
$global:jsonFilesStored = 0
$global:bpmnFilesStored = 0
$global:decisionInstancesProcessed = 0

# Retrieve all process instances for the specified business key
$instanceUrl = "$baseUrl/history/process-instance?processInstanceBusinessKey=$BusinessKey"

try {
    $allInstancesResponse = Invoke-RestMethodWithProxy -Uri $instanceUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment
} catch {
    Write-Error "Unable to connect to the remote server: $($_.Exception.Message)"
    exit 1
}

# Also try to fetch any missing root processes that might not have the business key
$rootProcessIds = $allInstancesResponse | Where-Object { $_.rootProcessInstanceId } | Select-Object -ExpandProperty rootProcessInstanceId -Unique

foreach ($rootId in $rootProcessIds) {
    $hasRootProcess = $allInstancesResponse | Where-Object { $_.id -eq $rootId }
    
    if (-not $hasRootProcess) {
        try {
            $rootUrl = "$baseUrl/history/process-instance/$rootId"
            $rootProcess = Invoke-RestMethodWithProxy -Uri $rootUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment
            
            if ($rootProcess) {
                $allInstancesResponse += $rootProcess
            }
        } catch {
            Write-Warning "Could not fetch root process $rootId`: $($_.Exception.Message)"
        }
    }
}

$totalInstancesFound = $allInstancesResponse.Count
Write-Output "Found $totalInstancesFound total process instances for business key: $BusinessKey"

if ($totalInstancesFound -eq 0) {
    Write-Output "No process instances found for business key: $BusinessKey"
    exit 0
}

# Group instances by workflow run cycles - detect new runs when first process repeats
$sortedInstances = $allInstancesResponse | Sort-Object startTime
$runGroups = @{}

Write-Output "Grouping instances by workflow run cycles..."

if ($sortedInstances.Count -eq 0) {
    Write-Output "No instances to process"
    exit 0
}

# Identify the first process type (this will be our run delimiter)
$firstProcessKey = $sortedInstances[0].processDefinitionKey
Write-Output "First process identified: '$firstProcessKey' - this will mark the start of each run"

# Count occurrences of the first process to determine how many runs we have
$firstProcessOccurrences = @($sortedInstances | Where-Object { $_.processDefinitionKey -eq $firstProcessKey })
$totalRuns = $firstProcessOccurrences.Count
Write-Output "Found $totalRuns occurrences of '$firstProcessKey', indicating $totalRuns total runs"

# Determine which runs to process based on MaxRuns
$runsToProcess = [Math]::Min($MaxRuns, $totalRuns)
$startFromOccurrence = $totalRuns - $runsToProcess + 1

Write-Output "Will process latest $runsToProcess runs (starting from occurrence $startFromOccurrence of '$firstProcessKey')"

# Find the cutoff point - start from the (totalRuns - MaxRuns + 1)th occurrence of first process
$currentOccurrence = 0
$cutoffIndex = -1

for ($i = 0; $i -lt $sortedInstances.Count; $i++) {
    if ($sortedInstances[$i].processDefinitionKey -eq $firstProcessKey) {
        $currentOccurrence++
        if ($currentOccurrence -eq $startFromOccurrence) {
            $cutoffIndex = $i
            break
        }
    }
}

# Process only instances from the cutoff point onward
if ($cutoffIndex -ge 0) {
    $instancesToProcess = $sortedInstances[$cutoffIndex..($sortedInstances.Count - 1)]
    Write-Output "Processing $($instancesToProcess.Count) instances from latest $runsToProcess runs"
} else {
    $instancesToProcess = $sortedInstances
    Write-Output "Processing all $($instancesToProcess.Count) instances"
}

# Now group the filtered instances into runs
$currentRunId = 1
$seenFirstProcessInCurrentRun = $false

foreach ($instance in $instancesToProcess) {
    $processKey = $instance.processDefinitionKey
    
    # If we see the first process and we've already seen it in this run, start a new run
    if ($processKey -eq $firstProcessKey -and $seenFirstProcessInCurrentRun) {
        $currentRunId++
        $seenFirstProcessInCurrentRun = $false
    }
    
    # Mark that we've seen the first process in this run
    if ($processKey -eq $firstProcessKey) {
        $seenFirstProcessInCurrentRun = $true
    }
    
    $runId = "run-$currentRunId"
    
    if (-not $runGroups.ContainsKey($runId)) {
        $runGroups[$runId] = @()
    }
    $runGroups[$runId] += $instance
}

# Convert to array of runs, sorted by the earliest start time in each run
$runs = @()
foreach ($runId in $runGroups.Keys) {
    $runInstances = $runGroups[$runId] | Sort-Object startTime
    $runs += ,@($runInstances)
}

# Sort runs by the start time of their first instance (only if multiple runs)
if ($runs.Count -gt 1) {
    $runs = $runs | Sort-Object { [DateTime]::Parse($_[0].startTime) }
}

Write-Output "Identified $($runs.Count) distinct runs from $($instancesToProcess.Count) processed instances"

# All runs are already filtered to the desired MaxRuns, so process them all
$selectedRuns = $runs
Write-Output "Processing all $($selectedRuns.Count) filtered runs"

# Flatten the selected runs back into a single array of instances
$instanceResponse = @()
$runIndex = 1
foreach ($run in $selectedRuns) {
    $runStartTime = ([DateTime]::Parse($run[0].startTime)).ToString("yyyy-MM-dd HH:mm:ss")
    Write-Output "Run $runIndex of $($selectedRuns.Count): $($run.Count) instances starting at $runStartTime"
    $instanceResponse += $run
    $runIndex++
}

$totalInstances = $instanceResponse.Count
Write-Output "Processing $totalInstances instances from $($selectedRuns.Count) latest runs"
Write-Output "PROGRESS_TOTAL:$totalInstances"
#endregion

#region [================== PROCESS INSTANCE PROCESSING ==================]
$currentInstance = 0
foreach ($instance in $instanceResponse) {
    $currentInstance++
    Write-Output "PROGRESS_CURRENT:$currentInstance"
    $processInstanceId = $instance.id
    $processDefinitionId = $instance.processDefinitionId
    $processKey = $instance.processDefinitionKey

    Write-Output "`nProcess Instance ID: $processInstanceId"
    Write-Output "Process Definition ID: $processDefinitionId"

    # Retrieve process execution history and diagram
    $activityUrl = "$baseUrl/history/activity-instance?processInstanceId=$processInstanceId"
    $activities = Invoke-RestMethodWithProxy -Uri $activityUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment

    Write-Output "`nExecuted Activities:"
    foreach ($activity in $activities) {
        Write-Output "- ID: $($activity.activityId), Type: $($activity.activityType), Name: $($activity.activityName)"
    }

    $diagramUrl = "$baseUrl/process-definition/$processDefinitionId/xml"
    $diagram = Invoke-RestMethodWithProxy -Uri $diagramUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment

    $bpmnFileName = "$processKey-$BusinessKey-$processInstanceId.bpmn"
    Save-DiagramInMemory -filename $bpmnFileName -content $diagram.bpmn20Xml -type "diagram" -sessionId $SessionId
    Write-Output "`nBPMN Diagram stored in memory: $bpmnFileName"

    # Store process execution trace
    $activityIds = $activities | Select-Object -ExpandProperty activityId
    $bpmnJsonFileName = "$processKey-$BusinessKey-$processInstanceId.json"
    $bpmnTrace = [PSCustomObject]@{
        processInstanceId = $processInstanceId
        processDefinitionId = $processDefinitionId
        processDefinitionKey = $processKey
        startTime = $instance.startTime
        endTime = $instance.endTime
        executedActivities = $activityIds
    }
    $bpmnTraceJson = $bpmnTrace | ConvertTo-Json -Depth 3
    Save-DiagramInMemory -filename $bpmnJsonFileName -content $bpmnTraceJson -type "execution-data" -sessionId $SessionId
    Write-Output "`nBPMN activity trace stored in memory: $bpmnJsonFileName"

    # Retrieve and store process variable data with deserializeValues=false to get full dataset
    Write-Output "`nRetrieving process variable data for process instance: $processInstanceId"
    try {
        $variableUrl = "$baseUrl/history/variable-instance?processInstanceId=$processInstanceId&deserializeValues=false"
        
        $variables = @()
        $batchSize = 50
        $firstResult = 0
        $hasMore = $true
        
        while ($hasMore) {
            $batchUrl = "$variableUrl" + "&firstResult=$firstResult" + "&maxResults=$batchSize"
            
            try {
                $batchVariables = Invoke-RestMethodWithProxy -Uri $batchUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment
                
                if ($batchVariables) {
                    $batchArray = if ($batchVariables -is [Array]) { $batchVariables } else { @($batchVariables) }
                    
                    if ($batchArray.Count -gt 0) {
                        $variables += $batchArray
                        $firstResult += $batchSize
                        
                        if ($batchArray.Count -lt $batchSize) {
                            $hasMore = $false
                        }
                    } else {
                        $hasMore = $false
                    }
                } else {
                    $hasMore = $false
                }
            } catch {
                Write-Output "ERROR in variable batch: $($_.Exception.Message)"
                $hasMore = $false
            }
        }
        
        if ($variables -and $variables.Count -gt 0) {
            Write-Output "Retrieved $($variables.Count) variables for $processKey"
            
            # Process variables in chunks to avoid PowerShell JSON truncation
            $chunkSize = 20
            $totalChunks = [Math]::Ceiling($variables.Count / $chunkSize)
            
            Write-Output "Processing vars in $totalChunks chunks of $chunkSize vars each..."
            
            # Process each chunk
            for ($chunkIndex = 0; $chunkIndex -lt $totalChunks; $chunkIndex++) {
                $startIndex = $chunkIndex * $chunkSize
                $endIndex = [Math]::Min($startIndex + $chunkSize - 1, $variables.Count - 1)
                $chunk = $variables[$startIndex..$endIndex]
                
                Write-Output "Processing chunk $($chunkIndex + 1)/$totalChunks (variables $($startIndex + 1) to $($endIndex + 1))"
                
                try {
                    $chunkFileName = "$processKey-$BusinessKey-$processInstanceId-variables-chunk-$($chunkIndex).json"
                    
                    $chunkData = @{
                        chunkIndex = $chunkIndex
                        totalChunks = $totalChunks
                        variableCount = $chunk.Count
                        processInstanceId = $processInstanceId
                        processKey = $processKey
                        variables = $chunk
                    }
                    
                    $chunkDataJson = $chunkData | ConvertTo-Json -Depth 10 -Compress:$false
                    Save-DiagramInMemory -filename $chunkFileName -content $chunkDataJson -type "variable-chunk" -sessionId $SessionId
                    
                    Write-Output "SUCCESS: Stored chunk $($chunkIndex + 1): $chunkFileName ($($chunk.Count) vars)"
                    
                } catch {
                    Write-Warning "ERROR: Failed to process chunk $($chunkIndex + 1): $($_.Exception.Message)"
                }
            }
            
            # Create summary with chunk file references
            $summaryData = @{
                processKey = $processKey
                processInstanceId = $processInstanceId
                businessKey = $BusinessKey
                totalVariables = $variables.Count
                totalChunks = $totalChunks
                chunkFiles = @()
            }
            
            # Add chunk file references to summary
            for ($i = 0; $i -lt $totalChunks; $i++) {
                $summaryData.chunkFiles += "$processKey-$BusinessKey-$processInstanceId-variables-chunk-$i.json"
            }
            
            $summaryFileName = "$processKey-$BusinessKey-$processInstanceId-variables-summary.json"
            $summaryJson = $summaryData | ConvertTo-Json -Depth 5 -Compress:$false
            Save-DiagramInMemory -filename $summaryFileName -content $summaryJson -type "variable-summary" -sessionId $SessionId
            
            Write-Output "SUCCESS: Stored variable summary: $summaryFileName (total: $($variables.Count) vars in $totalChunks chunks)"
        } else {
            Write-Output "No variables found for $processKey ($processInstanceId)"
        }
    } catch {
        Write-Warning "Failed to retrieve variables for process instance $processInstanceId`: $($_.Exception.Message)"
    }

    # Process decision instances (DMN tables) for this process instance
    $decisionUrl = "$baseUrl/history/decision-instance" + "?processInstanceId=$processInstanceId" + "&includeInputs=true" + "&includeOutputs=true"
    $decisionInstances = Invoke-RestMethodWithProxy -Uri $decisionUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment

    $decisionGroups = $decisionInstances | Group-Object -Property decisionDefinitionKey
    
    $decisionCount = 0
    foreach ($decisionGroup in $decisionGroups) {
        $decisionCount++
        Write-Output "Processing DMN decision group $decisionCount of $($decisionGroups.Count) for instance $currentInstance (Key: $($decisionGroup.Name))"
        
        $firstDecision = $decisionGroup.Group[0]
        $decisionId = $firstDecision.decisionDefinitionId
        $decisionKey = $firstDecision.decisionDefinitionKey

        $dmnUrl = "$baseUrl/decision-definition/$decisionId/xml"
        $dmnXml = Invoke-RestMethodWithProxy -Uri $dmnUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment

        foreach ($decision in $decisionGroup.Group) {
            $global:decisionInstancesProcessed++
            
            $dmnInstanceFileName = "$decisionKey-$BusinessKey-$($decision.id).dmn"
            Save-DiagramInMemory -filename $dmnInstanceFileName -content $dmnXml.dmnXml -type "diagram" -sessionId $SessionId
            Write-Output "DMN Diagram stored in memory: $dmnInstanceFileName"
            
            # Extract rule IDs from decision outputs
            $instanceRuleIds = @()
            $hasInstanceRuleIds = $false
            
            if ($decision.outputs -and $decision.outputs.Count -gt 0) {
                $instanceRuleIds = @($decision.outputs | Where-Object { $_.ruleId } | Select-Object -ExpandProperty ruleId | Sort-Object -Unique)
                
                if ($instanceRuleIds.Count -gt 0) {
                    $hasInstanceRuleIds = $true
                    Write-Output "Extracted rule IDs from outputs: $($instanceRuleIds -join ', ')"
                }
            }
            
            # Create decision execution data
            if ($hasInstanceRuleIds) {
                $decisionInstanceData = New-DecisionInstanceData -RuleIds $instanceRuleIds -HasRuleIds $hasInstanceRuleIds -HasAuditLog $false -Inputs $decision.inputs -Outputs $decision.outputs -DecisionKey $decisionKey -DecisionId $decisionId -DecisionName $firstDecision.decisionDefinitionName -ProcessKey $processKey -ProcessInstanceId $processInstanceId -EvaluationTime $decision.evaluationTime
            } elseif (-not $hasInstanceRuleIds) {
                try {
                    $auditUrl = "$baseUrl/history/decision-instance/$($decision.id)/auditLog"
                    $auditLog = Invoke-RestMethodWithProxy -Uri $auditUrl -Method Get -Credential $credential -ProxyServer $proxyServer -ProxyCredential $proxyCredential -Environment $Environment
                    Write-Output "Audit log retrieved successfully for instance $($decision.id)!"
                    
                    if ($auditLog.evaluatedOutputs) {
                        $instanceRuleIds = @($auditLog.evaluatedOutputs | Select-Object -ExpandProperty ruleId -ErrorAction SilentlyContinue | Sort-Object -Unique)
                        if ($instanceRuleIds.Count -gt 0) {
                            $hasInstanceRuleIds = $true
                        }
                    }
                    
                    $decisionInstanceData = New-DecisionInstanceData -RuleIds $instanceRuleIds -HasRuleIds $hasInstanceRuleIds -HasAuditLog $true -AuditData $auditLog -Inputs $decision.inputs -Outputs $decision.outputs -DecisionKey $decisionKey -DecisionId $decisionId -DecisionName $firstDecision.decisionDefinitionName -ProcessKey $processKey -ProcessInstanceId $processInstanceId -EvaluationTime $decision.evaluationTime
                } catch {
                    Write-Warning "No audit log found for decision instance: $($decision.id)"
                    
                    $decisionInstanceData = New-DecisionInstanceData -RuleIds @() -HasRuleIds $false -HasAuditLog $false -Inputs $decision.inputs -Outputs $decision.outputs -DecisionKey $decisionKey -DecisionId $decisionId -DecisionName $firstDecision.decisionDefinitionName -ProcessKey $processKey -ProcessInstanceId $processInstanceId -EvaluationTime $decision.evaluationTime
                }
            }
            
            # Store decision execution data
            $dmnInstanceJsonFileName = "$decisionKey-$BusinessKey-$($decision.id).json"
            $dmnInstanceTraceJson = $decisionInstanceData | ConvertTo-Json -Depth 6
            Save-DiagramInMemory -filename $dmnInstanceJsonFileName -content $dmnInstanceTraceJson -type "execution-data" -sessionId $SessionId
            Write-Output "DMN instance trace stored in memory: $dmnInstanceJsonFileName"
        }
    }
}
#endregion

#region [================== COMPLETION SUMMARY ==================]
Write-Output "DATA_FETCH_COMPLETE"
Write-Output ""
Write-Output "=== STORAGE SUMMARY ==="
Write-Output "Total instances found for business key: $totalInstancesFound"
Write-Output "Runs identified: $($runs.Count)"
Write-Output "Runs processed (latest): $($selectedRuns.Count)"
Write-Output "Instances processed: $totalInstances"
Write-Output "Decision instances processed: $global:decisionInstancesProcessed"
Write-Output "BPMN files stored: $global:bpmnFilesStored"
Write-Output "DMN files stored: $global:dmnFilesStored"
Write-Output "JSON files stored: $global:jsonFilesStored"
Write-Output "Total files stored: $($global:bpmnFilesStored + $global:dmnFilesStored + $global:jsonFilesStored)"
if ($totalInstancesFound -gt $totalInstances) {
    Write-Output "NOTE: Limited to latest $($selectedRuns.Count) runs from $($runs.Count) total runs to improve performance."
}
Write-Output "Diagrams and traces stored in memory. Open http://localhost:3000 in your browser and click to explore the process visually!"
#endregion
