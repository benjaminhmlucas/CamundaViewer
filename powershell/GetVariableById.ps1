<#
.SYNOPSIS
    Gets a specific variable by ID from Camunda with deserialization
.DESCRIPTION
    Retrieves a single variable from Camunda Historic Variable Instance API with automatic deserialization.
    This script is used by the Camunda Viewer to deserialize Java serialized objects on demand.
.PARAMETER environment
    The environment to connect to (dev, test, uat, local, etc.)
.PARAMETER processInstanceId
    The process instance ID that contains the variable
.PARAMETER variableName
    The name of the variable to retrieve
.PARAMETER camundaUser
    Username for Camunda authentication
.PARAMETER camundaPassword
    Password for Camunda authentication (will be converted to SecureString)
.PARAMETER outputJson
    Switch to output result as JSON for consumption by Node.js server
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$environment,
    
    [Parameter(Mandatory=$true)]
    [string]$processInstanceId,
    
    [Parameter(Mandatory=$true)]
    [string]$variableName,
    
    [switch]$outputJson
)

# Read domain from config file
$configPath = Join-Path $PSScriptRoot "..\config-$environment.cfg"
$domain = $null

if (Test-Path $configPath) {
    try {
        $configLines = Get-Content $configPath
        foreach ($line in $configLines) {
            $line = $line.Trim()
            # Skip comments and empty lines
            if ($line -and -not $line.StartsWith('#')) {
                $parts = $line.Split('=', 2)
                if ($parts.Length -eq 2) {
                    $key = $parts[0].Trim()
                    $value = $parts[1].Trim()
                    
                    if ($key -eq 'BASE_URL') {
                        $domain = $value
                        break
                    }
                }
            }
        }
        Write-Verbose "Loaded domain from config file: $domain"
    } catch {
        Write-Warning "Could not read config file: $_"
    }
}

# Fallback to local if no config found or domain not specified
if (-not $domain) {
    if ($environment -eq "local") {
        $domain = "http://localhost:8080"
        Write-Verbose "Using fallback local domain: $domain"
    } else {
        if ($outputJson) {
            $errorResult = @{
                success = $false
                error = "Could not determine Camunda URL for environment '$environment'. Please check config-$environment.cfg file contains BASE_URL setting."
            }
            Write-Output ($errorResult | ConvertTo-Json -Depth 10)
            exit 1
        } else {
            Write-Error "Could not determine Camunda URL for environment '$environment'. Please check config-$environment.cfg file contains BASE_URL setting."
            exit 1
        }
    }
}

# Read all configuration from config file
$camundaUser = $null
$camundaPassword = $null
$proxyServer = $null
$proxyUser = $null
$proxyPassword = $null

try {
    $configPath = Join-Path $PSScriptRoot "..\config-$environment.cfg"
    if (Test-Path $configPath) {
        $configLines = Get-Content $configPath
        foreach ($line in $configLines) {
            $line = $line.Trim()
            # Skip comments and empty lines
            if ($line -and -not $line.StartsWith('#')) {
                $parts = $line.Split('=', 2)
                if ($parts.Length -eq 2) {
                    $key = $parts[0].Trim()
                    $value = $parts[1].Trim()
                    
                    if ($key -eq 'USERNAME') {
                        $camundaUser = $value
                    }
                    elseif ($key -eq 'PASSWORD') {
                        $camundaPassword = $value
                    }
                    elseif ($key -eq 'PROXY_SERVER') {
                        $proxyServer = $value
                    }
                    elseif ($key -eq 'PROXY_USERNAME') {
                        $proxyUser = $value
                    }
                    elseif ($key -eq 'PROXY_PASSWORD') {
                        $proxyPassword = $value
                    }
                }
            }
        }
        Write-Verbose "Loaded config from: $configPath"
        Write-Verbose "Username: $(if ($camundaUser) { 'SET' } else { 'NOT_SET' })"
        Write-Verbose "Password: $(if ($camundaPassword) { 'SET' } else { 'NOT_SET' })"
        Write-Verbose "Proxy Server: $(if ($proxyServer) { $proxyServer } else { 'NOT_SET' })"
        Write-Verbose "Proxy User: $(if ($proxyUser) { 'SET' } else { 'NOT_SET' })"
    }
} catch {
    Write-Warning "Could not read config file: $_"
}

# Validate credentials
if (-not $camundaUser -or -not $camundaPassword) {
    if ($outputJson) {
        $errorResult = @{
            success = $false
            error = "Camunda credentials are required. Provide via parameters or config file."
        }
        Write-Output ($errorResult | ConvertTo-Json -Depth 10)
        exit 1
    } else {
        Write-Error "Camunda credentials are required. Provide via parameters or config file."
        exit 1
    }
}

try {
    # Create secure credentials using direct .NET method to avoid module loading issues
    $securePassword = [System.Security.SecureString]::new()
    foreach ($char in $camundaPassword.ToCharArray()) {
        $securePassword.AppendChar($char)
    }
    $credential = New-Object System.Management.Automation.PSCredential ($camundaUser, $securePassword)
    
    Write-Verbose "Secure credentials created successfully"
    
    # Configure proxy if specified
    $proxyParams = @{}
    if ($proxyServer) {
        $proxyParams.Proxy = "http://$proxyServer"
        $proxyParams.ProxyUseDefaultCredentials = $false
        Write-Verbose "Using proxy: $proxyServer"
        
        if ($proxyUser -and $proxyPassword) {
            # Create proxy credentials using direct .NET method for cross-platform compatibility
            try {
                $secureProxyPassword = [System.Security.SecureString]::new()
                foreach ($char in $proxyPassword.ToCharArray()) {
                    $secureProxyPassword.AppendChar($char)
                }
                $proxyCredential = New-Object System.Management.Automation.PSCredential ($proxyUser, $secureProxyPassword)
                $proxyParams.ProxyCredential = $proxyCredential
                Write-Verbose "Proxy credentials configured using direct .NET method"
            } catch {
                Write-Warning "Failed to create proxy credentials: $($_.Exception.Message)"
            }
        }
    }
    
    # Add PowerShell version-specific certificate handling for cross-platform compatibility
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        if ($environment -eq "local") {
            $proxyParams.AllowUnencryptedAuthentication = $true
        }
        $proxyParams.SkipCertificateCheck = $true
    }
    
    # First, get all variables for the process instance to find the variable ID
    $variablesUrl = "$domain/history/variable-instance"
    $variableSearchBody = @{
        processInstanceId = $processInstanceId
        variableName = $variableName
        deserializeValues = $false  # Get raw data first to find the variable
    } | ConvertTo-Json
    
    Write-Verbose "Searching for variable: $variableName in process instance: $processInstanceId"
    
    $searchResponse = Invoke-RestMethod -Uri $variablesUrl -Method Post -Credential $credential -Body $variableSearchBody -ContentType 'application/json' @proxyParams
    
    if (-not $searchResponse -or $searchResponse.Count -eq 0) {
        if ($outputJson) {
            $errorResult = @{
                success = $false
                error = "Variable '$variableName' not found in process instance '$processInstanceId'"
            }
            Write-Output ($errorResult | ConvertTo-Json -Depth 10)
            exit 1
        } else {
            Write-Error "Variable '$variableName' not found in process instance '$processInstanceId'"
            exit 1
        }
    }
    
    # Get the first (and should be only) variable match
    $variable = $searchResponse[0]
    $variableId = $variable.id
    
    Write-Verbose "Found variable ID: $variableId"
    
    # Now get the specific variable with deserialization enabled
    $variableUrl = "$domain/history/variable-instance/$variableId"
    
    Write-Verbose "Calling Camunda API: $variableUrl"
    
    $response = Invoke-RestMethod -Uri $variableUrl -Method Get -Credential $credential @proxyParams
    
    if ($response) {
        $result = @{
            success = $true
            value = $response.value
            type = $response.type
            objectType = $response.valueInfo.objectTypeName
            variableId = $response.id
            variableName = $response.name
            processInstanceId = $response.processInstanceId
            createTime = $response.createTime
        }
        
        if ($outputJson) {
            Write-Output ($result | ConvertTo-Json -Depth 20)
        } else {
            Write-Output "Variable: $($response.name)"
            Write-Output "Type: $($response.type)"
            if ($response.valueInfo.objectTypeName) {
                Write-Output "Object Type: $($response.valueInfo.objectTypeName)"
            }
            Write-Output "Variable ID: $($response.id)"
            Write-Output "Process Instance: $($response.processInstanceId)"
            Write-Output "Create Time: $($response.createTime)"
        }
    } else {
        if ($outputJson) {
            $errorResult = @{
                success = $false
                error = "No response received from Camunda API"
            }
            Write-Output ($errorResult | ConvertTo-Json -Depth 10)
            exit 1
        } else {
            Write-Error "No response received from Camunda API"
            exit 1
        }
    }
    
} catch {
    $errorMessage = $_.Exception.Message
    if ($_.Exception.Response) {
        $statusCode = $_.Exception.Response.StatusCode
        $errorMessage += " (HTTP $statusCode)"
        
        # Try to get more details from the response
        try {
            $errorDetails = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($errorDetails)
            $errorBody = $reader.ReadToEnd()
            if ($errorBody) {
                $errorMessage += ": $errorBody"
            }
        } catch {
            # Ignore errors reading error response
        }
    }
    
    # Add proxy configuration info to error for debugging
    $proxyInfo = if ($proxyServer) { "Using proxy: $proxyServer" } else { "No proxy configured" }
    $errorMessage += " [$proxyInfo]"
    
    if ($outputJson) {
        $errorResult = @{
            success = $false
            error = $errorMessage
            statusCode = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
            proxyConfigured = if ($proxyServer) { $true } else { $false }
            proxyServer = $proxyServer
        }
        Write-Output ($errorResult | ConvertTo-Json -Depth 10)
        exit 1
    } else {
        Write-Error "Error calling Camunda API: $errorMessage"
        exit 1
    }
}
